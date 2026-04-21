'use strict';

let clients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => {
    try   { c.write(msg); return true; }
    catch { return false; }
  });
}

function addClient(res)    { clients.push(res); }
function removeClient(res) { clients = clients.filter(c => c !== res); }

module.exports = { broadcast, addClient, removeClient };
