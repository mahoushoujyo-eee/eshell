import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

const useStore = create((set, get) => ({
  sessions: [], // { id, name, host, port, username, password }
  activeSessionId: null,
  terminals: [], // { id, sessionId, title }
  activeTerminalId: null,
  activeTerminalSelection: "",
  
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
      return { sessions: newSessions };
    });
  },

  setActiveSessionId: (id) => set({ activeSessionId: id }),
  
  addTerminal: (terminal) => set((state) => ({ 
    terminals: [...state.terminals, terminal],
    activeTerminalId: terminal.id
  })),
  removeTerminal: (id) => set((state) => ({ 
    terminals: state.terminals.filter(t => t.id !== id),
    activeTerminalId: state.activeTerminalId === id ? (state.terminals.length > 1 ? state.terminals[0].id : null) : state.activeTerminalId
  })),
  setActiveTerminalId: (id) => set({ activeTerminalId: id }),
  setActiveTerminalSelection: (text) => set({ activeTerminalSelection: text }),
}));

export default useStore;
