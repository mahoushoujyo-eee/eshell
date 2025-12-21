import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

const useStore = create((set, get) => ({
  sessions: [], // { id, name, host, port, username, password }
  activeSessionId: null,
  terminals: [], // { id, sessionId, title }
  activeTerminalId: null,
  activeTerminalSelection: "",
  connectedSessions: {}, // 跟踪已连接的session {sessionId: true}
  
  loadSessions: async () => {
    try {
      const config = await invoke('load_config');
      if (config && config.sessions) {
        set({ sessions: config.sessions });
      }
    } catch (e) {
      console.error("Failed to load config", e);
    }
  },

  addSession: async (session) => {
    set((state) => {
      const newSessions = [...state.sessions, session];
      invoke('save_config', { config: { sessions: newSessions } }).catch(console.error);
      return { sessions: newSessions };
    });
  },

  updateSession: async (session) => {
    set((state) => {
      const newSessions = state.sessions.map(s => s.id === session.id ? session : s);
      invoke('save_config', { config: { sessions: newSessions } }).catch(console.error);
      return { sessions: newSessions };
    });
  },

  removeSession: async (id) => {
    set((state) => {
      const newSessions = state.sessions.filter(s => s.id !== id);
      invoke('save_config', { config: { sessions: newSessions } }).catch(console.error);
      // 同时从已连接集合中移除
      const newConnected = { ...state.connectedSessions };
      delete newConnected[id];
      return { sessions: newSessions, connectedSessions: newConnected };
    });
  },

  setActiveSessionId: (id) => set({ activeSessionId: id }),
  
  addTerminal: (terminal) => set((state) => ({ 
    terminals: [...state.terminals, terminal],
    activeTerminalId: terminal.id,
    activeSessionId: terminal.sessionId  // 同时更新activeSessionId
  })),
  
  removeTerminal: (id) => set((state) => {
    const removedTerminal = state.terminals.find(t => t.id === id);
    const newTerminals = state.terminals.filter(t => t.id !== id);
    
    // 检查是否还有其他终端使用同一个session
    const sessionStillInUse = removedTerminal ? 
      newTerminals.some(t => t.sessionId === removedTerminal.sessionId) : false;
    
    // 如果session不再被使用，从已连接集合中移除
    const newConnected = { ...state.connectedSessions };
    if (!sessionStillInUse && removedTerminal) {
      delete newConnected[removedTerminal.sessionId];
      // 可选：调用后端关闭session
      invoke('close_session', { id: removedTerminal.sessionId }).catch(console.error);
    }
    
    // 确定新的activeTerminalId和activeSessionId
    const newActiveTerminalId = state.activeTerminalId === id ? 
      (newTerminals.length > 0 ? newTerminals[0].id : null) : 
      state.activeTerminalId;
    
    const newActiveSessionId = newActiveTerminalId ? 
      newTerminals.find(t => t.id === newActiveTerminalId)?.sessionId : null;
    
    return { 
      terminals: newTerminals,
      activeTerminalId: newActiveTerminalId,
      activeSessionId: newActiveSessionId,
      connectedSessions: newConnected
    };
  }),
  
  setActiveTerminalId: (id) => set({ activeTerminalId: id }),
  setActiveTerminalSelection: (text) => set({ activeTerminalSelection: text }),
  
  // 标记session为已连接
  markSessionConnected: (sessionId) => set((state) => ({
    connectedSessions: { ...state.connectedSessions, [sessionId]: true }
  })),
  
  // 标记session为已断开
  markSessionDisconnected: (sessionId) => set((state) => {
    const newConnected = { ...state.connectedSessions };
    delete newConnected[sessionId];
    return { connectedSessions: newConnected };
  }),
}));

export default useStore;
