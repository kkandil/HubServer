'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { requests, responses } = require('./protocol');

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createGateway({ hubToken, appToken }) {
  if (!hubToken || !appToken || hubToken === appToken) {
    throw new Error('Separate HUB_TOKEN and APP_TOKEN are required');
  }
  const app = express();
  const server = http.createServer(app);
  const io = require('socket.io')(server, { allowEIO3: true, pingInterval: 25000, pingTimeout: 60000, maxHttpBufferSize: 100000 });
  const phones = new Map();
  let hub = null;
  app.get('/', (_req, res) => res.json({ service: 'SmartHome gateway', hubOnline: !!hub }));
  app.get('/health', (_req, res) => res.status(hub ? 200 : 503).json({ hubOnline: !!hub }));
  io.use((socket, next) => next(sameSecret(socket.handshake.query.token, appToken)
    ? undefined : new Error('Unauthorized')));
  const hubs = io.of('/hub');
  hubs.use((socket, next) => next(sameSecret(socket.handshake.query.token, hubToken)
    ? undefined : new Error('Unauthorized')));

  function attach(phone) {
    phone.ready = false;
    phone.socket.emit('HubStatus', { online: false });
    if (hub) hub.emit('PhoneOpen', { id: phone.socket.id });
  }
  hubs.on('connection', socket => {
    if (hub) hub.disconnect(true);
    hub = socket;
    for (const phone of phones.values()) attach(phone);
    socket.on('PhoneReady', data => {
      if (hub !== socket || !data) return;
      const phone = phones.get(data.id);
      if (phone) {
        phone.ready = true;
        phone.socket.emit('HubStatus', { online: true });
      }
    });
    socket.on('PhoneUnavailable', data => {
      if (hub !== socket || !data) return;
      const phone = phones.get(data.id);
      if (phone) {
        phone.ready = false;
        phone.socket.emit('HubStatus', { online: false });
      }
    });
    socket.on('PhoneResponse', data => {
      if (hub !== socket || !data || !responses.includes(data.event)) return;
      const phone = phones.get(data.id);
      if (phone) phone.socket.emit(data.event, data.payload);
    });
    socket.on('disconnect', () => {
      if (hub !== socket) return;
      hub = null;
      for (const phone of phones.values()) attach(phone);
    });
  });
  io.on('connection', socket => {
    const phone = { socket, ready: false };
    phones.set(socket.id, phone);
    attach(phone);
    for (const event of requests) socket.on(event, payload => {
      // Never queue device commands across an outage or replay them later.
      if (!hub || !phone.ready) return socket.emit(event, payload?.requestId
        ? { requestId: payload.requestId, status: 'Error', message: 'Home hub is offline' } : 'Hub_Offline');
      hub.emit('PhoneRequest', { id: socket.id, event, payload });
    });
    socket.on('disconnect', () => {
      phones.delete(socket.id);
      if (hub) hub.emit('PhoneClose', { id: socket.id });
    });
  });
  return { server, close: () => new Promise(resolve => io.close(resolve)) };
}

if (require.main === module) {
  (async () => {
    let gateway;
    if(process.env.CONFIG_MONGO_URI) {
      const {MongoClient}=require('mongodb'); const {ConfigStore,MongoHomes}=require('./config-store');
      const mongo=new MongoClient(process.env.CONFIG_MONGO_URI); await mongo.connect();
      const db=mongo.db('SmartHomeHubConfig');
      const accounts=process.env.ACCOUNTS_ENABLED==='true'?new (require('./accounts').Accounts)(db,{legacyToken:process.env.APP_TOKEN,ownerEmail:'khaledmagdy50@gmail.com'}):null;
      if(accounts)await accounts.init();
      const store=new ConfigStore(new MongoHomes(db));
      const {PushNotifications,firebaseMessaging}=require('./push-notifications');
      const push=accounts?new PushNotifications({db,accounts,store,messaging:firebaseMessaging()}):null;
      if(push)await push.init();
      gateway=require('./multi-gateway').createMultiGateway({store,push,appToken:process.env.APP_TOKEN,bindings:JSON.parse(process.env.HUB_BINDINGS||'{}'),accounts});
    } else gateway=createGateway({ hubToken: process.env.HUB_TOKEN, appToken: process.env.APP_TOKEN });
    gateway.server.listen(Number(process.env.PORT || 3000), () => console.log('SmartHome gateway listening'));
  })().catch(e=>{console.error('Gateway startup failed:',e.message);process.exit(1);});
}
module.exports = { createGateway };
