'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('pihole', {
  // Config
  readConfig: () => invoke('config:read'),
  saveConfig: (cfg) => invoke('config:save', cfg),

  // Connection
  connect: () => invoke('pihole:connect'),

  // Dashboard
  getStats: () => invoke('pihole:stats'),
  getTopDomains: () => invoke('pihole:top-domains'),
  getTopClients: () => invoke('pihole:top-clients'),
  getGravity: () => invoke('pihole:gravity'),

  // Domain management
  listDomains: (query) => invoke('pihole:domains:list', query),
  addDomain: (domain, list) => invoke('pihole:domains:add', { domain, list }),
  removeDomain: (domain, list) => invoke('pihole:domains:remove', { domain, list }),
});
