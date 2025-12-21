import React, { useState } from 'react';
import { Input, Button, message, Space, List } from 'antd';
import { PlayCircleOutlined, CopyOutlined, DeleteOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const { TextArea } = Input;

const CommandEditor = () => {
  const { activeSessionId } = useStore();
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState([]);

  const handleRunCommand = async () => {
    if (!command.trim()) {
      message.warning('Please enter a command');
      return;
    }

    if (!activeSessionId) {
      message.warning('Please connect to a server first');
      return;
    }

    try {
      await invoke('send_command', {
        id: activeSessionId,
        command: command + '\n'
      });
      
      // Add to history
      setHistory(prev => [{
        id: Date.now(),
        command,
        timestamp: new Date().toLocaleTimeString()
      }, ...prev].slice(0, 20)); // Keep last 20
      
      message.success('Command executed');
    } catch (e) {
      message.error(`Failed to execute: ${e}`);
    }
  };

  const handleCopyCommand = (cmd) => {
    navigator.clipboard.writeText(cmd);
    message.success('Copied to clipboard');
  };

  const handleUseCommand = (cmd) => {
    setCommand(cmd);
  };

  const handleClearHistory = () => {
    setHistory([]);
    message.success('History cleared');
  };

  return (
    <div className="h-full flex flex-col bg-[#1e1e1e] text-white p-4">
      <div className="mb-4">
        <h3 className="text-lg font-semibold mb-2">Command Editor</h3>
        <TextArea
          value={command}
          onChange={e => setCommand(e.target.value)}
          placeholder="Enter commands here...&#10;You can write multiple lines"
          rows={6}
          className="mb-2"
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              handleRunCommand();
            }
          }}
        />
        <Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleRunCommand}
            disabled={!activeSessionId}
          >
            Execute (Ctrl+Enter)
          </Button>
          <Button onClick={() => setCommand('')}>Clear</Button>
        </Space>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="flex justify-between items-center mb-2">
          <h4 className="text-sm font-semibold text-gray-400">Command History</h4>
          {history.length > 0 && (
            <Button 
              type="text" 
              size="small" 
              onClick={handleClearHistory}
              className="text-gray-400"
            >
              Clear All
            </Button>
          )}
        </div>
        
        <div className="flex-1 overflow-auto">
          {history.length === 0 ? (
            <div className="text-center text-gray-500 text-sm mt-8">
              No command history yet
            </div>
          ) : (
            <List
              dataSource={history}
              renderItem={item => (
                <List.Item
                  className="border-b border-[#333] hover:bg-[#2d2d2d] px-2"
                  actions={[
                    <Button
                      key="use"
                      type="text"
                      size="small"
                      onClick={() => handleUseCommand(item.command)}
                      className="text-blue-500"
                    >
                      Use
                    </Button>,
                    <Button
                      key="copy"
                      type="text"
                      icon={<CopyOutlined />}
                      size="small"
                      onClick={() => handleCopyCommand(item.command)}
                      className="text-green-500"
                    />,
                    <Button
                      key="delete"
                      type="text"
                      icon={<DeleteOutlined />}
                      size="small"
                      onClick={() => setHistory(prev => prev.filter(h => h.id !== item.id))}
                      className="text-red-500"
                    />
                  ]}
                >
                  <List.Item.Meta
                    title={<span className="text-white text-xs font-mono">{item.command}</span>}
                    description={<span className="text-gray-500 text-xs">{item.timestamp}</span>}
                  />
                </List.Item>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandEditor;
