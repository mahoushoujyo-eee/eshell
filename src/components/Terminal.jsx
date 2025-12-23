import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import useStore from '../store/useStore';

const Terminal = ({ terminalId, sessionId }) => {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const { sessions, activeTerminalId, connectedSessions, markSessionConnected } = useStore();
  const session = sessions.find(s => s.id === sessionId);
  const isActiveTerminal = activeTerminalId === terminalId;
  const isSessionConnected = connectedSessions[sessionId] === true;

  useEffect(() => {
    if (!terminalRef.current || !session) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
      }
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    
    term.open(terminalRef.current);
    fitAddon.fit();
    
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Handle input
    const onDataHandler = term.onData(data => {
      invoke('send_command', { id: sessionId, command: data });
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (xtermRef.current) {
        const { rows, cols } = xtermRef.current;
        invoke('resize_term', { id: sessionId, rows, cols });
      }
    };
    
    window.addEventListener('resize', handleResize);
    const onResizeHandler = term.onResize(size => {
        invoke('resize_term', { id: sessionId, rows: size.rows, cols: size.cols });
    });

    const onSelectionHandler = term.onSelectionChange(() => {
        useStore.getState().setActiveTerminalSelection(term.getSelection());
    });

    // Listen for data from Rust
    const unlistenPromise = listen(`ssh_data_${sessionId}`, (event) => {
      term.write(event.payload);
    });
    
    const unlistenErrorPromise = listen(`ssh_error_${sessionId}`, (event) => {
        term.writeln(`\r\nSSH Error: ${event.payload}\r\n`);
    });

    const unlistenClosedPromise = listen(`ssh_closed_${sessionId}`, (event) => {
        term.writeln(`\r\nSSH Connection Closed.\r\n`);
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      onDataHandler.dispose();
      onResizeHandler.dispose();
      onSelectionHandler.dispose();
      term.dispose();
      unlistenPromise.then(unlisten => unlisten());
      unlistenErrorPromise.then(unlisten => unlisten());
      unlistenClosedPromise.then(unlisten => unlisten());
    };
  }, [sessionId]); // 只依赖sessionId

  // 连接SSH - 只在session未连接时执行
  useEffect(() => {
    if (!session || isSessionConnected) return;

    invoke('connect_ssh', { config: session })
      .then(() => {
        console.log(`Session ${sessionId} connected successfully`);
        // 连接成功后才标记为已连接
        markSessionConnected(sessionId);
      })
      .catch(err => {
        console.error(`Failed to connect session ${sessionId}:`, err);
        // 连接失败时不标记，允许重试
      });
  }, [sessionId, session, isSessionConnected, markSessionConnected]); // 依赖sessionId和连接状态

  // 当标签页切换时通知后端设置活跃会话
  useEffect(() => {
    if (isActiveTerminal && sessionId) {
      invoke('set_active_session', { id: sessionId }).catch(console.error);
    }
  }, [isActiveTerminal, sessionId]);

  return <div className="h-full w-full p-2 pb-3 px-3" ref={terminalRef} />;
};

export default Terminal;
