import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/desktop-api'
import type { ControllerEvent } from '../shared/controller'

const api: DesktopAPI = {
  request: (method, params = {}) => ipcRenderer.invoke('controller:request', method, params),
  subscribe: callback => {
    const listener = (_event: Electron.IpcRendererEvent, message: ControllerEvent) => callback(message)
    ipcRenderer.on('controller:event', listener)
    return () => ipcRenderer.removeListener('controller:event', listener)
  },
  restartController: () => ipcRenderer.invoke('controller:restart'),
  info: () => ipcRenderer.invoke('app:info'),
  openDirectory: kind => ipcRenderer.invoke('app:directory', kind),
  exportRecords: runId => ipcRenderer.invoke('records:export', runId),
  getDisplayRange: () => ipcRenderer.invoke('ui:range:get'),
  setDisplayRange: range => ipcRenderer.invoke('ui:range:set', range),
  getTheme: () => ipcRenderer.invoke('ui:theme:get'),
  setTheme: theme => ipcRenderer.invoke('ui:theme:set', theme)
}
contextBridge.exposeInMainWorld('labDesktop', api)
