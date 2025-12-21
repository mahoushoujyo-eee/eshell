import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import useStore from '../store/useStore';

const Terminal = ({ terminalId, sessionId }) => {
  const terminalRef = useRef(null);
  const xtermRef = useRef(null);
  const fitAddonRef = useRef(null);
  const { sessions } = useStore();
  const session = sessions.find(s => s.id === sessionId);

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

    // Connect to SSH
    invoke('connect_ssh', { config: session }).catch(err => {
      term.writeln(`\r\nError connecting: ${err}\r\n`);
    });

    // Handle input
    term.onData(data => {
      invoke('send_command', { id: session.id, command: data });
    });

    // Handle resize
    const handleResize = () => {
      fitAddon.fit();
      if (xtermRef.current) {
        const { rows, cols } = xtermRef.current;
        invoke('resize_term', { id: session.id, rows, cols });
      }
    };
    
    window.addEventListener('resize', handleResize);
    term.onResize(size => {
        invoke('resize_term', { id: session.id, rows: size.rows, cols: size.cols });
    });

    term.onSelectionChange(() => {
        useStore.getState().setActiveTerminalSelection(term.getSelection());
    });

    // Listen for data from Rust
    const unlistenPromise = listen(`ssh_data_${session.id}`, (event) => {
      term.write(event.payload);
    });
    
    const unlistenErrorPromise = listen(`ssh_error_${session.id}`, (event) => {
        term.writeln(`\r\nSSH Error: ${event.payload}\r\n`);
    });

    const unlistenConnectedPromise = listen(`ssh_connected_${session.id}`, (event) => {
        term.writeln(`\r\nSSH Connected.\r\n`);
        handleResize(); // Resize after connection
    });

    const unlistenClosedPromise = listen(`ssh_closed_${session.id}`, (event) => {
        term.writeln(`\r\nSSH Connection Closed.\r\n`);
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      unlistenPromise.then(unlisten => unlisten());
      unlistenErrorPromise.then(unlisten => unlisten());
      unlistenConnectedPromise.then(unlisten => unlisten());
      unlistenClosedPromise.then(unlisten => unlisten());
    };
  }, [session]);

  return <div className="h-full w-full" ref={terminalRef} />;
};

export default Terminal;
