'use strict';

// Keep the legacy Android/ESP event contract. Devices connect only to the Pi.
const requests = [
  'PhoneConnect', 'AddNewHome', 'GetAllHomes', 'DeleteHome', 'AddDevice',
  'DeleteDevice', 'AddVariable', 'DeleteDeviceVariable', 'PhoneWriteVariable',
  'RequestVariableValue', 'GetVariableValueFromServer', 'GetDeviceStatus',
  'GetAllDevices', 'GetDeviceVariables'
];
const responses = [...requests, 'DeviceStatus', 'DeviceDeleted', 'DeviceWriteVariable'];
module.exports = { requests, responses };
