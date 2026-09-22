'use strict';

// Keep the legacy Android/ESP event contract. Devices connect only to the Pi.
const requests = [
  'PhoneConnect', 'AddNewHome', 'GetAllHomes', 'DeleteHome', 'AddDevice',
  'DeleteDevice', 'AddVariable', 'DeleteDeviceVariable', 'PhoneWriteVariable',
  'RequestVariableValue', 'GetVariableValueFromServer', 'GetVariableSnapshot', 'GetDeviceStatus',
  'GetAllDevices', 'GetDeviceVariables', 'GetSchedules', 'SaveSchedule', 'DeleteSchedule',
  'GetEvents', 'SaveEvent', 'DeleteEvent', 'SetEventEnabled', 'GetEventVariables'
];
const responses = [...requests, 'DeviceStatus', 'DeviceDeleted', 'DeviceWriteVariable', 'SchedulesChanged', 'EventsChanged'];
module.exports = { requests, responses };
