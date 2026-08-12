import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('__flow_electron', {
  platform: process.platform,
})
