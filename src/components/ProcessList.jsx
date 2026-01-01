import React, { useEffect, useState } from 'react';
import { Table } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const ProcessList = ({ terminalId }) => {
  const { activeSessionId, getTabCache, setTabCache, connectedSessions } = useStore();
  const [processes, setProcesses] = useState([]);
  const isSessionConnected = connectedSessions[activeSessionId] === true;

  useEffect(() => {
    if (!activeSessionId || !terminalId || !isSessionConnected) return;
    
    // 先尝试从缓存加载数据
    const cache = getTabCache(terminalId);
    if (cache && cache.processes) {
      setProcesses(cache.processes);
    }
    
    // 然后异步刷新最新数据
    loadProcesses();
    
    const interval = setInterval(() => {
      loadProcesses();
    }, 3000);

    return () => clearInterval(interval);
  }, [activeSessionId, terminalId, isSessionConnected]);
  
  const loadProcesses = async () => {
    if (!activeSessionId || !terminalId) return;
    try {
      const result = await invoke('get_top_processes', {
        sessionId: activeSessionId
      });
      setProcesses(result);
      
      // 保存到缓存
      const cache = getTabCache(terminalId);
      setTabCache(terminalId, 'processes', result);
    } catch (e) {
      console.error('Failed to get processes:', e);
    }
  };

  const columns = [
    { 
      title: 'PID', 
      dataIndex: 'pid', 
      key: 'pid', 
      width: 50, 
      className: 'text-xs',
      ellipsis: false,
      render: (text) => <div className="whitespace-nowrap overflow-hidden text-ellipsis">{text}</div>
    },
    { 
      title: 'CPU', 
      dataIndex: 'cpu', 
      key: 'cpu', 
      width: 50, 
      className: 'text-xs',
      ellipsis: false,
      render: (text) => <div className="whitespace-nowrap overflow-hidden text-ellipsis">{text}</div>
    },
    { 
      title: 'Mem', 
      dataIndex: 'memory', 
      key: 'memory', 
      width: 50, 
      className: 'text-xs',
      ellipsis: false,
      render: (text) => <div className="whitespace-nowrap overflow-hidden text-ellipsis">{text}</div>
    },
    { 
      title: 'Name', 
      dataIndex: 'name', 
      key: 'name', 
      className: 'text-xs',
      ellipsis: true,
      render: (text) => <div className="whitespace-nowrap overflow-hidden text-ellipsis" title={text}>{text}</div>
    },
  ];

  if (!activeSessionId) {
    return (
      <div className="p-4 text-[var(--text-secondary)] text-sm text-center">
        Connect to a server to view processes
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
      <style>{`
        .custom-table .ant-table-body {
          overflow-y: auto !important;
        }
        .custom-table .ant-table-body::-webkit-scrollbar {
          width: 4px;
        }
        .custom-table .ant-table-body::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-table .ant-table-body::-webkit-scrollbar-thumb {
          background: var(--border-color);
          border-radius: 2px;
        }
        .custom-table .ant-table-body::-webkit-scrollbar-thumb:hover {
          background: var(--text-secondary);
        }
      `}</style>
      <Table 
        dataSource={processes} 
        columns={columns} 
        pagination={false} 
        size="small"
        scroll={{ y: 'calc(100vh - 380px)' }}
        className="flex-1 custom-table text-xs"
        rowKey="pid"
        locale={{ emptyText: <span className="text-xs text-[var(--text-secondary)]">Loading...</span> }}
      />
    </div>
  );
};

export default ProcessList;
