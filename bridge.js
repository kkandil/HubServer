'use strict';

const connect = require('socket.io-client');
const { requests, responses } = require('./protocol');

function startBridge({ gatewayUrl, hubToken, localUrl }) {
  if (!hubToken) throw new Error('HUB_TOKEN is required when GATEWAY_URL is set');
  const sessions = new Map();
  const hub = connect(gatewayUrl.replace(/\/$/, '') + '/hub', {
    query: { token: hubToken }, transports: ['websocket'], forceNew: true,
    reconnection: true, reconnectionDelay: 2000, reconnectionDelayMax: 30000
  });
  function closePhone(id) {
    const phone = sessions.get(id);
    if (phone) { sessions.delete(id); phone.disconnect(); }
  }
  hub.on('connect', () => console.log('Gateway bridge connected'));
  hub.on('disconnect', () => {
    console.log('Gateway unavailable; local service continues');
    for (const id of [...sessions.keys()]) closePhone(id);
  });
  hub.on('connect_error', () => console.log('Gateway connection unavailable; retrying'));
  hub.on('PhoneOpen', data => {
    if (!data || typeof data.id !== 'string') return;
    closePhone(data.id);
    const phone = connect(localUrl, { forceNew: true, transports: ['websocket'] });
    sessions.set(data.id, phone);
    phone.on('connect', () => phone.emit('PhoneConnect', { phoneID: 'gateway:' + data.id }));
    phone.on('PhoneConnect', result => {
      if (result === 'OK' && hub.connected) hub.emit('PhoneReady', { id: data.id });
    });
    for (const event of responses) phone.on(event, payload => {
      if (hub.connected) hub.emit('PhoneResponse', { id: data.id, event, payload });
    });
    phone.on('disconnect', () => {
      if (hub.connected && sessions.get(data.id) === phone) hub.emit('PhoneUnavailable', { id: data.id });
    });
  });
  hub.on('PhoneClose', data => { if (data) closePhone(data.id); });
  hub.on('PhoneRequest', data => {
    if (!data || !requests.includes(data.event)) return;
    const phone = sessions.get(data.id);
    if (!phone || !phone.connected) {
      hub.emit('PhoneResponse', { id: data.id, event: data.event, payload: 'Hub_Offline' });
      return;
    }
    // The relay owns a unique phone ID, independent of the Android device ID.
    const payload = data.event === 'PhoneConnect' ? { phoneID: 'gateway:' + data.id } : data.payload;
    phone.emit(data.event, payload);
  });
  return { close() { hub.disconnect(); for (const id of [...sessions.keys()]) closePhone(id); } };
}
module.exports = { startBridge };
