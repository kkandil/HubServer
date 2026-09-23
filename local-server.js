////////////////////////////////////////////////////////////////////////////////////////////
// socket.IO

var app = require('express')();
var server = require('http').Server(app);
const io = require('socket.io')(server, {
	allowEIO3: true,
	pingTimeout: 60000,
	pingInterval: 25000
});
const PORT = process.env.PORT || 3000;
const DEBUG_LOGGING_ENABLED = true;

const ConnectedPhonesList = new Map();
// key = `${homeName}|${deviceId}`
const ConnectedDevicesList = new Map();
var ScheduleList = new Map();

const { SQLiteClient } = require('./sqlite-store');
const client = new SQLiteClient(process.env.DATA_FILE || './data/smarthome.sqlite');
const variableState = new (require('./variable-state').VariableState)(client.sql);
const { Scheduler } = require('./scheduler');
const automationHandlers = {
	resolveTarget: async target => {
		const device = await GetDevicesCollection(target.homeName).findOne({ id: target.deviceID });
		if (!device) return null;
		const variable = await GetHomeDb(target.homeName).collection('Var_' + device.Name).findOne({ VarName: target.varName });
		return variable ? { ...variable, deviceName: device.Name } : null;
	},
	dispatch: async target => {
		const device = await GetDevicesCollection(target.homeName).findOne({ id: target.deviceID });
		if (!device) return 'missing_target';
		const variables = GetHomeDb(target.homeName).collection('Var_' + device.Name);
		if (!await variables.findOne({ VarName: target.varName })) return 'missing_target';
		const connection = ConnectedDevicesList.get(MakeConnectedDeviceKey(target.homeName, target.deviceID));
		if (!connection || !connection.Socket.connected) return 'skipped_offline';
		const payload = { homeName: target.homeName, deviceID: target.deviceID,
			varName: target.varName, varType: target.varType, varValue: target.varValue };
		connection.Socket.emit('PhoneWriteVariable', payload);
		await UpdateVariableValue(target.homeName, device.Name, target.varName, target.varValue);
		return 'sent'; // Transport dispatch, not a hardware acknowledgement.
	},
	onChange: target => {
		for (const phone of ConnectedPhonesList.values()) phone.Socket.emit('SchedulesChanged', {
			homeName: target.homeName, deviceID: target.deviceID, varName: target.varName
		});
	}
};
const scheduler = new Scheduler(client.sql, automationHandlers);
const { EventEngine } = require('./events');
const events = new EventEngine(client.sql, {
	...automationHandlers,
	catalog: async homeName => {
		const devices = await GetDevicesCollection(homeName).find().toArray();
		return Promise.all(devices.map(async device => ({ deviceID: device.id, deviceName: device.Name,
			variables: (await GetHomeDb(homeName).collection('Var_' + device.Name).find().toArray())
				.map(v => ({ varName: v.VarName, varType: v.Type })) })));
	},
	onChange: rule => {
		for (const phone of ConnectedPhonesList.values()) phone.Socket.emit('EventsChanged', { homeName: rule.homeName });
	}
});
const homeSync=process.env.HUB_HOME?new (require('./home-sync').HomeSync)({client,events,scheduler,connections:ConnectedDevicesList,homeName:process.env.HUB_HOME,token:process.env.HUB_TOKEN}):null;

function GetMetaDb() {
	return client.db("SmartHomeMeta");
}

function GetCountersCollection() {
	return GetMetaDb().collection("Counters");
}

////////////////////////////////////////////////////////////////////////////////////////////
// MongoDB helpers

function GetHomeDb(homeName) {
	return client.db(homeName);
}

function GetDevicesCollection(homeName) {
	return GetHomeDb(homeName).collection("Devices");
}

function MakeConnectedDeviceKey(homeName, deviceId) {
	return homeName + "|" + deviceId;
}

function IsValidHomeName(homeName) {
	if (!homeName || typeof homeName !== "string") return false;
	return /^[A-Za-z0-9_\-]+$/.test(homeName);
}

async function run() {
	try {
		await client.connect();
		await client.db("admin").command({ ping: 1 });
		// Persisted statuses cannot survive a server restart: sockets must register again.
		const { databases } = await client.db().admin().listDatabases();
		for (const db of databases) {
			const devices = await client.db(db.name).collection('Devices').find().toArray();
			for (const device of devices) {
				await client.db(db.name).collection('Devices').updateOne({ id: device.id },
					{ $set: { Status: 'Not_Connected' } });
			}
		}
		await events.start();
		console.log('Local SQLite store ready');
	} catch (err) {
		throw err;
	}
}

async function HomeExists(homeName) {
	try {
		if (!IsValidHomeName(homeName)) return false;

		const adminDb = client.db().admin();
		const dbs = await adminDb.listDatabases();
		const found = dbs.databases.find(db => db.name === homeName);
		return found != null;
	} catch (err) {
		console.error(`HomeExists: ${err}`);
		return false;
	}
}

async function AddNewHome(homeName) {
	try {
		if (!IsValidHomeName(homeName)) {
			return { status: -3 };
		}

		const exists = await HomeExists(homeName);
		if (exists) {
			return { status: -1 };
		}

		const homeDb = GetHomeDb(homeName);

		// create Devices collection so the DB actually exists
		await homeDb.createCollection("Devices");

		// optional metadata collection
		await homeDb.collection("HomeInfo").insertOne({
			HomeName: homeName,
			CreatedAt: new Date()
		});

		return { status: 0 };
	} catch (err) {
		console.error(`AddNewHome: ${err}`);
		return { status: -2 };
	}
}

async function GetAllHomes() {
	try {
		const adminDb = client.db().admin();
		const dbs = await adminDb.listDatabases();

		const systemDbs = ["admin", "local", "config", "SmartHomeMeta"];
		const homes = [];

		for (const db of dbs.databases) {
			if (systemDbs.includes(db.name)) {
				continue;
			}

			const collections = await client.db(db.name).listCollections({}, { nameOnly: true }).toArray();
			const hasDevicesCollection = collections.some(col => col.name === "Devices");

			if (hasDevicesCollection) {
				homes.push(db.name);
			}
		}

		return { status: 0, homes };
	} catch (err) {
		console.error(`GetAllHomes: ${err}`);
		return { status: -1, homes: [] };
	}
}

async function DeleteHome(homeName) {
	try {
		if (!IsValidHomeName(homeName)) {
			return { status: -3 };
		}

		const exists = await HomeExists(homeName);
		if (!exists) {
			return { status: -1 };
		}

		const homeDb = client.db(homeName);
		scheduler.removeTarget(homeName);
		await events.removeTarget(homeName);

		const collections = await homeDb.listCollections({}, { nameOnly: true }).toArray();

		for (const col of collections) {
			await homeDb.collection(col.name).drop();
		}

		// remove connected devices from memory
		for (const [key, deviceData] of ConnectedDevicesList.entries()) {
			if (deviceData.HomeName === homeName) {
				ConnectedDevicesList.delete(key);
			}
		}

		return { status: 0 };
	} catch (err) {
		console.error(`DeleteHome: ${err}`);
		return { status: -2 };
	}
}

async function AddNewDevice(homeName, deviceName) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return { status: -2, deviceId: null };
		}

		const devicesCol = GetDevicesCollection(homeName);

		// optional: prevent duplicate device names inside the same home
		const existingDevice = await devicesCol.findOne({ Name: deviceName });
		if (existingDevice != null) {
			return { status: -1, deviceId: null };
		}

		const newDeviceId = await GenerateNextDeviceId();
		if (newDeviceId === -1) {
			return { status: -3, deviceId: null };
		}

		const doc = {
			Name: deviceName,
			id: newDeviceId,
			Status: "Not_Connected"
		};

		await devicesCol.insertOne(doc);

		return { status: 0, deviceId: newDeviceId };
	} catch (err) {
		console.error(`AddNewDevice: ${err}`);
		return { status: -4, deviceId: null };
	}
}

async function DeleteDevice(homeName, deviceId) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return { status: -2 };
		}

		const [result, deviceName, Id, Status] = await SearchForDeviceByID(homeName, deviceId);

		if (result !== 1) {
			return { status: -1 };
		}

		const devicesCol = GetDevicesCollection(homeName);

		await devicesCol.deleteOne({ id: deviceId });
		scheduler.removeTarget(homeName, deviceId);
		await events.removeTarget(homeName, deviceId);

		// delete variables collection for this device
		const varCollectionName = "Var_" + deviceName;
		const collections = await GetHomeDb(homeName).listCollections({ name: varCollectionName }).toArray();

		if (collections.length > 0) {
			await GetHomeDb(homeName).collection(varCollectionName).drop();
		}

		// remove from connected devices map
		const deviceKey = MakeConnectedDeviceKey(homeName, deviceId);
		if (ConnectedDevicesList.has(deviceKey)) {
			ConnectedDevicesList.delete(deviceKey);
		}

		return { status: 0, deviceName: deviceName };
	} catch (err) {
		console.error(`DeleteDevice: ${err}`);
		return { status: -3 };
	}
}

async function DeleteDeviceVariable(homeName, deviceId, varName) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return { status: -3 };
		}

		const [result, deviceName, Id, Status] = await SearchForDeviceByID(homeName, deviceId);

		if (result !== 1) {
			return { status: -1 };
		}

		const [varResult, value] = await SearchForVariable(homeName, deviceName, varName);

		if (varResult !== 1) {
			return { status: -2 };
		}

		const variablesCol = GetHomeDb(homeName).collection("Var_" + deviceName);
		await variablesCol.deleteOne({ VarName: varName });
		scheduler.removeTarget(homeName, deviceId, varName);
		await events.removeTarget(homeName, deviceId, varName);

		return { status: 0, deviceName: deviceName };
	} catch (err) {
		console.error(`DeleteDeviceVariable: ${err}`);
		return { status: -4 };
	}
}

async function UpdateDeviceStatus(homeName, deviceId, status) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return -2;
		}

		const devicesCol = GetDevicesCollection(homeName);
		const filter = { id: deviceId };
		const updateDocument = {
			$set: {
				Status: status,
			},
		};
		await devicesCol.updateOne(filter, updateDocument);
		return 0;
	} catch (err) {
		console.error(`UpdateDeviceStatus: ${err}`);
		return -1;
	}
}

async function AddNewVariable(homeName, deviceName, deviceId, variableName, value, type, scheduled, offTime, onTime, onValue, offValue) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return -2;
		}

		const devicesCol = GetDevicesCollection(homeName);
		const query = { Name: deviceName };
		const device = await devicesCol.findOne(query);

		if (device != null) {
			const variablesCol = GetHomeDb(homeName).collection("Var_" + deviceName);
			const doc = {
				VarName: variableName,
				DeviceId: deviceId,
				Value: value,
				Type: type,
				Scheduled: scheduled,
				OffTime: offTime,
				OnTime: onTime,
				OnValue: onValue,
				OffValue: offValue
			};
			await variablesCol.insertOne(doc);
			return 0;
		} else {
			return -1;
		}
	} catch (err) {
		console.error(`AddNewVariable: ${err}`);
		return -1;
	}
}

async function SearchForDeviceByID(homeName, deviceId) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return [-2, "None", 0, "None"];
		}

		const devicesCol = GetDevicesCollection(homeName);
		const query = { id: deviceId };
		const device = await devicesCol.findOne(query);

		if (device == null) {
			return [0, "None", 0, "None"];
		} else {
			return [1, device.Name, device.id, device.Status];
		}
	} catch (err) {
		console.error(`SearchForDeviceByID: ${err}`);
		return [-1, "None", 0, "None"];
	}
}

async function SearchForVariable(homeName, deviceName, varName) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return [-2, 0];
		}

		const variablesCol = GetHomeDb(homeName).collection("Var_" + deviceName);
		const query = { VarName: varName };
		const varFound = await variablesCol.findOne(query);

		if (varFound == null) {
			return [0, 0];
		} else {
			return [1, varFound.Value];
		}
	} catch (err) {
		console.error(`SearchForVariable: ${err}`);
		return [-1, 0];
	}
}

async function UpdateVariableValue(homeName, deviceName, varName, varValue) {
	try {
		const update=variableState.write(homeName,deviceName,varName,varValue);
		for (const {Socket} of ConnectedPhonesList.values()) Socket.emit('DeviceWriteVariable',update);
		events.changed(update).catch(error => console.error('Event evaluation:', error.message));
		return update;
	} catch (err) {
		console.error(`UpdateVariableValue: ${err}`);
		return -1;
	}
}

async function GetDeviceVariables(homeName, deviceID, deviceName) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return { status: -2, variables: [] };
		}

		const cols = await GetHomeDb(homeName).collection("Var_" + deviceName).find().toArray();

		if (!cols || cols.length === 0) {
			return { status: -1, variables: [] };
		}

		const variables = [];

		for (let i = 0; i < cols.length; i++) {
			if (cols[i]) {
				variables.push({
					VarName: cols[i].VarName,
					DeviceId: cols[i].DeviceId,
					Value: cols[i].Value,
					Type: cols[i].Type,
					Scheduled: cols[i].Scheduled,
					OffTime: cols[i].OffTime,
					OnTime: cols[i].OnTime,
					OnValue: cols[i].OnValue,
					OffValue: cols[i].OffValue
				});
			}
		}

		return { status: 0, variables };
	} catch (err) {
		console.error(`GetDeviceVariables: ${err}`);
		return { status: -3, variables: [] };
	}
}

async function GetAllDevices(homeName) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return { status: -2, devices: [] };
		}

		const devicesCol = GetDevicesCollection(homeName);
		const devices = await devicesCol
			.find({}, { projection: { _id: 0, Name: 1, id: 1, Status: 1 } })
			.toArray();

		if (!devices || devices.length === 0) {
			return { status: -1, devices: [] };
		}

		return { status: 0, devices: devices };
	} catch (err) {
		console.error(`GetAllDevices: ${err}`);
		return { status: -3, devices: [] };
	}
}

async function GenerateNextDeviceId() {
	try {
		const countersCol = GetCountersCollection();

		const doc = await countersCol.findOneAndUpdate(
			{ _id: "globalDeviceId" },
			{ $inc: { seq: 1 } },
			{
				upsert: true,
				returnDocument: 'after'
			}
		);

		if (doc && typeof doc.seq === "number") {
			return doc.seq;
		}

		return -1;
	} catch (err) {
		console.error(`GenerateNextDeviceId: ${err}`);
		return -1;
	}
}


async function UpdateDeviceConnectionTimes(homeName, deviceId, eventType) {
	try {
		const homeExists = await HomeExists(homeName);
		if (!homeExists) {
			return -2;
		}

		const devicesCol = GetDevicesCollection(homeName);
		const filter = { id: deviceId };
		const now = new Date().toISOString();

		let updateDocument = {};

		if (eventType === "connect") {
			LogMsg("Device connected at: " + now);
			updateDocument = {
				$set: {
					ConnectTime: now
				}
			};
		}
		else if (eventType === "disconnect") {
			LogMsg("Device disconnected at: " + now);
			updateDocument = {
				$set: {
					DisconnectTime: now
				}
			};
		}
		else {
			return -3;
		}

		await devicesCol.updateOne(filter, updateDocument);
		return 0;
	} catch (err) {
		console.error(`UpdateDeviceConnectionTimes: ${err}`);
		return -1;
	}
}
////////////////////////////////////////////////////////////////////////////////////////////
// Express

app.get('/', (req, res) => {
	res.send("Socket IO Start on port: " + PORT);
});

app.get('/health', (_req, res) => res.json({ service: 'SmartHome local', storage: 'sqlite' }));
let bridge;
run().then(() => server.listen(PORT, process.env.BIND_ADDRESS || '0.0.0.0', () => {
	console.log('Local SmartHome server listening on ' + PORT);
	scheduler.start();
	if (process.env.GATEWAY_URL) bridge = require('./bridge').startBridge({
		gatewayUrl: process.env.GATEWAY_URL,
		hubToken: process.env.HUB_TOKEN,
		localUrl: 'http://127.0.0.1:' + PORT
		,homeName: process.env.HUB_HOME
	});
})).catch(error => { console.error(error); process.exit(1); });

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
	scheduler.stop();
	if (bridge) bridge.close();
	io.close(() => client.close().then(() => process.exit(0)));
});

////////////////////////////////////////////////////////////////////////////////////////////
// socket.IO

io.on("connection", function (socket) {
	if(homeSync) {
		homeSync.attach(socket);
        if(socket.handshake.query.syncToken===process.env.HUB_TOKEN) socket.join('notification-bridge');
		const on=socket.on.bind(socket), edits=require('./config-store').edits;
		socket.on=(event,listener)=>on(event,(...args)=>{
			const input=args[0];
			if(process.env.ACCOUNTS_ENABLED==='true' && require('./protocol').requests.includes(event)
				&& socket.handshake.query.gatewayToken!==process.env.HUB_TOKEN) {
				return socket.emit(event,{status:'Error',requestId:input?.requestId,message:'Sign in through the home gateway'});
			}
			if(event==='GetAllHomes') return socket.emit(event,{homes:[process.env.HUB_HOME],homeStatuses:[{homeName:process.env.HUB_HOME,online:true}]});
			const message=input?.homeName && input.homeName!==process.env.HUB_HOME?'This hub belongs to '+process.env.HUB_HOME:edits.has(event)?'Use the Heroku gateway to edit home configuration; local device control remains available':null;
			if(message) return socket.emit(event,input?.requestId || ['AddDevice','DeleteDevice','DeleteDeviceVariable'].includes(event)?{status:'Error',requestId:input?.requestId,message}:message);
			return listener(...args);
		});
	}
	scheduler.attach(socket);
	events.attach(socket);
	socket.on('GetVariableSnapshot', input => {
		const started=Date.now();
        console.log(`GetVariableSnapshot received: home=${input?.homeName} requestId=${input?.requestId}`);
        try {
            const snapshot=variableState.snapshot(input?.homeName);
            socket.emit('GetVariableSnapshot',{status:'OK',requestId:input?.requestId,...snapshot});
            console.log(`GetVariableSnapshot sent: home=${input?.homeName} requestId=${input?.requestId} variables=${snapshot.values.length} revision=${snapshot.revision} elapsedMs=${Date.now()-started}`);
        }
		catch(e){socket.emit('GetVariableSnapshot',{status:'Error',requestId:input?.requestId,message:e.message});}
	});
	console.log("client connected id = " + socket.id);
	
	
	socket.on("connect_error", (err) => {
		LogMsg(`connect_error due to ${err.message}`);
	});
	
	// When transport upgrades (polling → websocket)
	socket.conn.on("upgrade", () => {
		console.log("Transport upgraded to:", socket.conn.transport.name);
	});

	// Engine-level close (very important)
	socket.conn.on("close", (reason) => {
		console.log("ENGINE CONNECTION CLOSED:", reason);
	});

	// Engine-level error
	socket.conn.on("error", (err) => {
		console.log("ENGINE ERROR:", err);
	});

	// Socket.IO errors
	socket.on("error", (err) => {
		console.log("SOCKET ERROR:", err);
	});

	socket.on("connect_error", (err) => {
		console.log("CONNECT ERROR:", err.message);
	});
	
	////////////////////////////////////////////////////////////////////////////////////////
	// Phone connect

	socket.on('PhoneConnect', function (data) {
		if (!data || data.hasOwnProperty('phoneID') == false) {
			socket.emit("PhoneConnect", "Empty_Parameter");
			return;
		}

		if (ConnectedPhonesList.has(data['phoneID'])) {
			ConnectedPhonesList.delete(data['phoneID']);
		}

		ConnectedPhonesList.set(data['phoneID'], { Socket: socket });

		LogMsg('PhoneConnect: ' + data['phoneID'] + ", SocketID: " + socket.id);
		socket.emit("PhoneConnect", "OK");
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Home events

	socket.on('AddNewHome', async function (data) {
		if (!data || data.hasOwnProperty('homeName') == false) {
			socket.emit('AddNewHome', "Empty_Parameter");
			return;
		}

		const result = await AddNewHome(data['homeName']);

		if (result.status === 0) {
			LogMsg("AddNewHome: " + data['homeName']);
			socket.emit('AddNewHome', "OK");
		}
		else if (result.status === -1) {
			socket.emit('AddNewHome', "Home_Exists");
		}
		else if (result.status === -3) {
			socket.emit('AddNewHome', "Invalid_Home_Name");
		}
		else {
			socket.emit('AddNewHome', "Server_Error");
		}
	});

	socket.on('GetAllHomes', async function (data) {
		const response = await GetAllHomes();

		if (response.status === 0) {
			socket.emit('GetAllHomes', { homes: response.homes });
		} else {
			socket.emit('GetAllHomes', "Server_Error");
		}
	});

	socket.on('DeleteHome', async function (data) {
		if (!data || data.hasOwnProperty('homeName') == false) {
			socket.emit('DeleteHome', "Empty_Parameter");
			return;
		}

		const response = await DeleteHome(data['homeName']);

		if (response.status === 0) {
			LogMsg("DeleteHome: " + data['homeName']);
			socket.emit('DeleteHome', "OK");
		}
		else if (response.status === -1) {
			socket.emit('DeleteHome', "Home_Not_Found");
		}
		else if (response.status === -3) {
			socket.emit('DeleteHome', "Invalid_Home_Name");
		}
		else {
			socket.emit('DeleteHome', "Server_Error");
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Device connect

	socket.on('DeviceConnect', async function (data) {
		if (!data || data.hasOwnProperty('homeName') == false || data.hasOwnProperty('deviceID') == false) {
			LogMsg('DeviceConnect: Error, Empty_Parameter');
			socket.emit('DeviceConnect', "Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('DeviceConnect', "Home_Not_Found");
			return;
		}

		const [result, deviceName, deviceId, Status] = await SearchForDeviceByID(data['homeName'], data['deviceID']);

		if (result == 1) {
			socket.emit('DeviceConnect', "OK");
			await UpdateDeviceStatus(data['homeName'], deviceId, "Connected");
			await UpdateDeviceConnectionTimes(data['homeName'], deviceId, "connect");
			
			const key = MakeConnectedDeviceKey(data['homeName'], deviceId);

			if (ConnectedDevicesList.has(key)) {
				ConnectedDevicesList.delete(key);
			}

			ConnectedDevicesList.set(key, {
				Socket: socket,
				Name: deviceName,
				HomeName: data['homeName'],
				DeviceId: deviceId
			});

			for (let [phoneId, { Socket }] of ConnectedPhonesList.entries()) {
				Socket.emit("DeviceStatus", {
					homeName: data['homeName'],
					DeviceId: data['deviceID'],
					DeviceStatus: "Connected"
				});
			}

			LogMsg("DeviceConnect: homeName: " + data['homeName'] + ", deviceName: " + deviceName + ", ID:" + deviceId + ", socketID: " + socket.id);
		}
		else {
			socket.emit('DeviceConnect', "Device_Not_Found");
			LogMsg('DeviceConnect: Error, device not found');
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Add device

	socket.on('AddDevice', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceName') == false) {
			LogMsg('AddDevice: Error, Empty_Parameter');
			socket.emit('AddDevice', "Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('AddDevice', "Home_Not_Found");
			return;
		}

		const response = await AddNewDevice(data['homeName'], data['deviceName']);

		if (response.status === 0) {
			LogMsg('AddDevice: homeName: ' + data['homeName'] +
				', deviceName: ' + data['deviceName'] +
				', assignedDeviceID: ' + response.deviceId);

			socket.emit('AddDevice', {
				status: "OK",
				homeName: data['homeName'],
				deviceName: data['deviceName'],
				deviceID: response.deviceId
			});
		}
		else if (response.status === -1) {
			LogMsg('AddDevice: Error, Device_Name_Exists');
			socket.emit('AddDevice', "Device_Name_Exists");
		}
		else if (response.status === -2) {
			socket.emit('AddDevice', "Home_Not_Found");
		}
		else {
			socket.emit('AddDevice', "Server_Error");
		}
	});

	
	////////////////////////////////////////////////////////////////////////////////////////
	// Delete device
	socket.on('DeleteDevice', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false) {
			LogMsg('DeleteDevice: Error, Empty_Parameter');
			socket.emit('DeleteDevice', "Empty_Parameter");
			return;
		}
		LogMsg("DeleteDevice: homeName=" + data['homeName'] + ", deviceID=" + data['deviceID']);
		const response = await DeleteDevice(data['homeName'], data['deviceID']);

		if (response.status === 0) {
			LogMsg("DeleteDevice: homeName=" + data['homeName'] + ", deviceID=" + data['deviceID']);

			// notify all connected phones
			for (let [phoneId, phoneData] of ConnectedPhonesList.entries()) {
				phoneData.Socket.emit("DeviceDeleted", {
					homeName: data['homeName'],
					deviceID: data['deviceID']
				});
			}

			socket.emit('DeleteDevice', {
				status: "OK",
				homeName: data['homeName'],
				deviceID: data['deviceID']
			});
		}
		else if (response.status === -1) {
			socket.emit('DeleteDevice', "Device_Not_Found");
		}
		else if (response.status === -2) {
			socket.emit('DeleteDevice', "Home_Not_Found");
		}
		else {
			socket.emit('DeleteDevice', "Server_Error");
		}
	});
	////////////////////////////////////////////////////////////////////////////////////////
	// Add variable

	socket.on('AddVariable', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false ||
			data.hasOwnProperty('varName') == false ||
			data.hasOwnProperty('varType') == false ||
			data.hasOwnProperty('varValue') == false ||
			data.hasOwnProperty('Scheduled') == false ||
			data.hasOwnProperty('OffTime') == false ||
			data.hasOwnProperty('OnTime') == false ||
			data.hasOwnProperty('OnValue') == false ||
			data.hasOwnProperty('OffValue') == false) {
			LogMsg('AddVariable: Error, Empty_Parameter');
			socket.emit('AddVariable', "Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('AddVariable', "Home_Not_Found");
			return;
		}

		const [result, DeviceName, Id, Status] = await SearchForDeviceByID(data['homeName'], data['deviceID']);

		if (result == 1) {
			const [varResult, value] = await SearchForVariable(data['homeName'], DeviceName, data['varName']);

			if (varResult == 1) {
				LogMsg('AddVariable: Error, Var_Exists');
				socket.emit('AddVariable', "Var_Exists");
			}
			else {
				LogMsg("AddVariable: homeName=" + data['homeName'] +
					", devId=" + data['deviceID'] +
					", varName=" + data['varName'] +
					", varType=" + data['varType'] +
					", varValue=" + data['varValue']);

				await AddNewVariable(
					data['homeName'],
					DeviceName,
					data['deviceID'],
					data['varName'],
					data['varValue'],
					data['varType'],
					data['Scheduled'],
					data['OffTime'],
					data['OnTime'],
					data['OnValue'],
					data['OffValue']
				);

				socket.emit('AddVariable', "OK");
			}
		}
		else {
			LogMsg('AddVariable: Error, Device_Not_Found');
			socket.emit('AddVariable', "Device_Not_Found");
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Delete variable
	socket.on('DeleteDeviceVariable', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false ||
			data.hasOwnProperty('varName') == false) {
			LogMsg('DeleteDeviceVariable: Error, Empty_Parameter');
			socket.emit('DeleteDeviceVariable', "Empty_Parameter");
			return;
		}

		const response = await DeleteDeviceVariable(
			data['homeName'],
			data['deviceID'],
			data['varName']
		);

		if (response.status === 0) {
			LogMsg("DeleteDeviceVariable: homeName=" + data['homeName'] +
				", deviceID=" + data['deviceID'] +
				", varName=" + data['varName']);

			socket.emit('DeleteDeviceVariable', {
				status: "OK",
				homeName: data['homeName'],
				deviceID: data['deviceID'],
				varName: data['varName']
			});
		}
		else if (response.status === -1) {
			socket.emit('DeleteDeviceVariable', "Device_Not_Found");
		}
		else if (response.status === -2) {
			socket.emit('DeleteDeviceVariable', "Var_Not_Found");
		}
		else if (response.status === -3) {
			socket.emit('DeleteDeviceVariable', "Home_Not_Found");
		}
		else {
			socket.emit('DeleteDeviceVariable', "Server_Error");
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Phone writes variable to device

	socket.on('PhoneWriteVariable', async function (data) {
        console.log(`PhoneWriteVariable received: home=${data?.homeName} device=${data?.deviceID} variable=${data?.varName} requestId=${data?.requestId || 'legacy'}`);
		const reply=(message,update)=>socket.emit('PhoneWriteVariable',data?.requestId?{status:message==='OK'?'OK':'Error',message,requestId:data.requestId,...update}:message);
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false ||
			data.hasOwnProperty('varName') == false ||
			data.hasOwnProperty('varType') == false ||
			data.hasOwnProperty('varValue') == false) {
			LogMsg('PhoneWriteVariable: Error, Empty_Parameter');
			reply("Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			reply("Home_Not_Found");
			return;
		}

		const [result, DeviceName, Id, Status] = await SearchForDeviceByID(data['homeName'], data['deviceID']);

		if (result == 1) {
			const [varResult, value] = await SearchForVariable(data['homeName'], DeviceName, data['varName']);

			if (varResult == 1) {
				const key = MakeConnectedDeviceKey(data['homeName'], Id);

				if (ConnectedDevicesList.has(key)) {
					ConnectedDevicesList.get(key)['Socket'].emit('PhoneWriteVariable', {
						homeName: data['homeName'],
						varName: data['varName'],
						varType: data['varType'],
						varValue: data['varValue']
					});

					
				}
				else {
					reply("Device_Not_Connected"); return;
				}

				const update=await UpdateVariableValue(data['homeName'], DeviceName, data['varName'], data['varValue']);
				reply(typeof update==='object'?'OK':'Server_Error',typeof update==='object'?update:undefined);

				LogMsg("PhoneWriteVariable: homeName=" + data['homeName'] +
					", devId=" + data['deviceID'] +
					", varName=" + data['varName'] +
					", varType=" + data['varType'] +
					", varValue=" + data['varValue']);
			}
			else {
				reply("Var_Not_Found");
				LogMsg('PhoneWriteVariable: Error, Var_Not_Found');
			}
		}
		else {
			reply("Device_Not_Found");
			LogMsg('PhoneWriteVariable: Error, Device_Not_Found');
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Device writes variable to phones

    socket.on('DeviceWriteNotification', data => {
        if (!data || typeof data.message !== 'string' || !data.message.trim() ||
            Buffer.byteLength(data.message, 'utf8') > 512) {
            socket.emit('DeviceWriteNotification', 'Invalid_Message'); return;
        }
        const device = ConnectedDevicesList.get(MakeConnectedDeviceKey(data.homeName, data.deviceID));
        if (!device || device.Socket !== socket) {
            socket.emit('DeviceWriteNotification', 'Device_Not_Connected'); return;
        }
        const now = Date.now();
        if (device.lastNotificationAt && now - device.lastNotificationAt < 1000) {
            socket.emit('DeviceWriteNotification', 'Rate_Limited'); return;
        }
        device.lastNotificationAt = now;
        const notification = { homeName: device.HomeName, deviceID: device.DeviceId,
            deviceName: device.Name, message: data.message, timestamp: now,
            notificationId: require('crypto').randomUUID() };
        for (const {Socket} of ConnectedPhonesList.values()) Socket.emit('DeviceWriteNotification', notification);
        io.to('notification-bridge').emit('HubNotification', notification);
        socket.emit('DeviceWriteNotification', 'OK');
        LogMsg('DeviceWriteNotification: home=' + device.HomeName + ' device=' + device.DeviceId);
    });

	socket.on('DeviceWriteVariable', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false ||
			data.hasOwnProperty('varName') == false ||
			data.hasOwnProperty('varType') == false ||
			data.hasOwnProperty('varValue') == false) {
			LogMsg('DeviceWriteVariable: Error, Empty_Parameter');
			socket.emit('DeviceWriteVariable', "Empty_Parameter");
			return;
		}
		
		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('DeviceWriteVariable', "Home_Not_Found");
			return;
		}

		const [result, DeviceName, Id, Status] = await SearchForDeviceByID(data['homeName'], data['deviceID']);

		if (result == 1) {
			const [varResult, value] = await SearchForVariable(data['homeName'], DeviceName, data['varName']);

			if (varResult == 1) {

				await UpdateVariableValue(data['homeName'], DeviceName, data['varName'], data['varValue']);

				socket.emit('DeviceWriteVariable', "OK");

				LogMsg("DeviceWriteVariable: homeName=" + data['homeName'] +
					", devId=" + data['deviceID'] +
					", varName=" + data['varName'] +
					", varType=" + data['varType'] +
					", varValue=" + data['varValue']);
			}
			else {
				socket.emit('DeviceWriteVariable', "Var_Not_Found");
				LogMsg('DeviceWriteVariable: Error, Var_Not_Found');
			}
		}
		else {
			socket.emit('DeviceWriteVariable', "Device_Not_Found");
			LogMsg('DeviceWriteVariable: Error, Device_Not_Found');
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Request variable value from device

	socket.on('RequestVariableValue', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false ||
			data.hasOwnProperty('varName') == false) {
			LogMsg('RequestVariableValue: Error, Empty_Parameter');
			socket.emit('RequestVariableValue', "Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('RequestVariableValue', "Home_Not_Found");
			return;
		}

		const [result, DeviceName, Id, Status] = await SearchForDeviceByID(data['homeName'], data['deviceID']);

		if (result == 1) {
			const [varResult, value] = await SearchForVariable(data['homeName'], DeviceName, data['varName']);

			if (varResult == 1) {
				const key = MakeConnectedDeviceKey(data['homeName'], Id);

				if (ConnectedDevicesList.has(key)) {
					ConnectedDevicesList.get(key)['Socket'].emit('GetVariableValueFromDevice', {
						homeName: data['homeName'],
						varName: data['varName']
					});
					socket.emit('RequestVariableValue', "OK");
				}
				else {
					socket.emit('RequestVariableValue', "Device_Not_Connected");
				}

				LogMsg("RequestVariableValue: homeName=" + data['homeName'] + ", devId=" + data['deviceID'] + ", varName=" + data['varName']);
			}
			else {
				socket.emit('RequestVariableValue', "Var_Not_Found");
				LogMsg('RequestVariableValue: Error, Var_Not_Found');
			}
		}
		else {
			socket.emit('RequestVariableValue', "Device_Not_Found");
			LogMsg('RequestVariableValue: Error, Device_Not_Found');
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Get variable value from DB

	socket.on('GetVariableValueFromServer', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false ||
			data.hasOwnProperty('varName') == false) {
			LogMsg('GetVariableValueFromServer: Error, Empty_Parameter');
			socket.emit('GetVariableValueFromServer', "Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('GetVariableValueFromServer', "Home_Not_Found");
			return;
		}

		const [result, DeviceName, Id, Status] = await SearchForDeviceByID(data['homeName'], data['deviceID']);

		if (result == 1) {
			const [varResult, value] = await SearchForVariable(data['homeName'], DeviceName, data['varName']);

			if (varResult == 1) {
				LogMsg("GetVariableValueFromServer: homeName=" + data['homeName'] + ", devId= " + data['deviceID'] + ", varName= " + data['varName'] + ", value= " + value);
				socket.emit('GetVariableValueFromServer', {
					homeName: data['homeName'],
					deviceID: data['deviceID'],
					varName: data['varName'],
					Value: value
				});
			}
			else {
				LogMsg('GetVariableValueFromServer: Error, Var_Not_Found');
				socket.emit('GetVariableValueFromServer', "Var_Not_Found");
			}
		}
		else {
			LogMsg('GetVariableValueFromServer: Error, Device_Not_Found');
			socket.emit('GetVariableValueFromServer', "Device_Not_Found");
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Get device status

	socket.on('GetDeviceStatus', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false) {
			LogMsg('GetDeviceStatus: Error, Empty_Parameter');
			socket.emit('GetDeviceStatus', "Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('GetDeviceStatus', "Home_Not_Found");
			return;
		}

		const devicesCol = GetDevicesCollection(data['homeName']);
		const device = await devicesCol.findOne({ id: data['deviceID'] });

		if (!device) {
			LogMsg('GetDeviceStatus: Error, Device_Not_Found');
			socket.emit('GetDeviceStatus', "Device_Not_Found");
			return;
		}

		let timeValue = "NA";

		if (device.Status === "Connected") {
			if (device.ConnectTime) {
				timeValue = device.ConnectTime;
			}
		}
		else if (device.Status === "Not_Connected") {
			if (device.DisconnectTime) {
				timeValue = device.DisconnectTime;
			}
		}

		LogMsg("GetDeviceStatus: homeName=" + data['homeName'] +
			", devId=" + data['deviceID'] +
			", status=" + device.Status +
			", time=" + timeValue);

		socket.emit("DeviceStatus", {
			homeName: data['homeName'],
			DeviceId: device.id,
			DeviceStatus: device.Status,
			Time: timeValue 
		});
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Get all devices for one home

	socket.on('GetAllDevices', async function (data) {
		if (!data || data.hasOwnProperty('homeName') == false) {
			socket.emit('GetAllDevices', "Empty_Parameter");
			return;
		}

		const response = await GetAllDevices(data['homeName']);

		if (response.status === 0) {
			socket.emit('GetAllDevices', {
				homeName: data['homeName'],
				devices: response.devices
			});
		}
		else if (response.status === -1) {
			socket.emit('GetAllDevices', {
				homeName: data['homeName'],
				devices: []
			});
		}
		else if (response.status === -2) {
			socket.emit('GetAllDevices', "Home_Not_Found");
		}
		else {
			socket.emit('GetAllDevices', "Server_Error");
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Get all variables of one device

	socket.on('GetDeviceVariables', async function (data) {
		if (!data ||
			data.hasOwnProperty('homeName') == false ||
			data.hasOwnProperty('deviceID') == false) {
			socket.emit('GetDeviceVariables', "Empty_Parameter");
			return;
		}

		const homeExists = await HomeExists(data['homeName']);
		if (!homeExists) {
			socket.emit('GetDeviceVariables', "Home_Not_Found");
			return;
		}

		const [result, DeviceName, Id, Status] = await SearchForDeviceByID(data['homeName'], data['deviceID']);

		if (result !== 1) {
			socket.emit('GetDeviceVariables', "Device_Not_Found");
			return;
		}

		const response = await GetDeviceVariables(data['homeName'], Id, DeviceName);

		if (response.status === 0 || response.status === -1) {
			socket.emit('GetDeviceVariables', {
				homeName: data['homeName'],
				deviceID: data['deviceID'],
				deviceName: DeviceName,
				variables: response.variables
			});
		}
		else {
			socket.emit('GetDeviceVariables', "Server_Error");
		}
	});

	////////////////////////////////////////////////////////////////////////////////////////
	// Disconnect

	socket.on('disconnect', async function (reason) {
		let isPhone = false;

		LogMsg("Client Disconnected: " + socket.id);
		LogMsg("====================================");
		LogMsg("Client DISCONNECTED");
		LogMsg("Socket ID:"+ socket.id);
		LogMsg("Reason:"+ reason);
		LogMsg("====================================");

		for (let [phoneId, { Socket }] of ConnectedPhonesList.entries()) {
			if (Socket.id == socket.id) {
				LogMsg("Phone Disconnected: " + socket.id);
				ConnectedPhonesList.delete(phoneId);
				isPhone = true;
				break;
			}
		}

		if (isPhone == false) {
			for (let [deviceKey, deviceData] of ConnectedDevicesList.entries()) {
				if (deviceData.Socket.id == socket.id) {
					LogMsg("Device Disconnected: homeName: " + deviceData.HomeName + ", name: " + deviceData.Name + ", socketID: " + socket.id);

					await UpdateDeviceStatus(deviceData.HomeName, deviceData.DeviceId, "Not_Connected");
					await UpdateDeviceConnectionTimes(deviceData.HomeName, deviceData.DeviceId, "disconnect");
					ConnectedDevicesList.delete(deviceKey);

					for (let [phoneId, phoneData] of ConnectedPhonesList.entries()) {
						phoneData.Socket.emit("DeviceStatus", {
							homeName: deviceData.HomeName,
							DeviceId: deviceData.DeviceId,
							DeviceStatus: "Not_Connected"
						});
					}
					break;
				}
			}
		}
	});
});

////////////////////////////////////////////////////////////////////////////////////////////
// Utils

function GetCurrentTime() {
	var time = new Date(Date.now());
	return [time.getHours(), time.getMinutes(), time.getSeconds()]
}

function GetCurrentTotalSeconds() {
	var time = new Date(Date.now());
	var totalSeconds = (time.getHours() * 60 * 60) + (time.getMinutes() * 60) + (time.getSeconds());
	return totalSeconds;
}

function ConverTotalSecondsToTime(totalSecond) {
	var hours = 0;
	var minutes = 0;
	var seconds = 0;
	seconds = Math.floor(totalSecond % 60);
	totalSecond = totalSecond / 60;
	minutes = Math.floor(totalSecond % 60);
	totalSecond = totalSecond / 60;
	hours = Math.floor(totalSecond % 60);
	return [hours, minutes, seconds];
}

function LogMsg(message) {
	if (DEBUG_LOGGING_ENABLED == true) {
		console.log(message);
	}
}
