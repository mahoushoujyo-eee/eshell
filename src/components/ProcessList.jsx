import React, { useEffect, useState } from 'react';
import { Table } from 'antd';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const ProcessList = () => {
  const { activeSessionId } = useStore();
  const [processes, setProcesses] = useState([]);

  useEffect(() => {
    if (!activeSessionId) return;
    
    const interval = setInterval(async () => {
      try {
        const result = await invoke('get_top_processes', {
          sessionId: activeSessionId
        });
        setProcesses(result);
      } catch (e) {
        console.error('Failed to get processes:', e);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [activeSessionId]);

  const columns = [
    { title: 'PID', dataIndex: 'pid', key: 'pid', width: 60, className: 'text-xs' },
    { title: 'CPU%', dataIndex: 'cpu', key: 'cpu', width: 55, className: 'text-xs' },
    { title: 'Memory', dataIndex: 'memory', key: 'memory', width: 60, className: 'text-xs' },
    { title: 'Name', dataIndex: 'name', key: 'name', ellipsis: true, className: 'text-xs' },
  ];

  if (!activeSessionId) {
    return (
      <div className="p-4 text-gray-500 text-sm text-center">
        Connect to a server to view processes
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#252526]">
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
          background: #424242;
          border-radius: 2px;
        }
        .custom-table .ant-table-body::-webkit-scrollbar-thumb:hover {
          background: #555;
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
        locale={{ emptyText: <span className="text-xs text-gray-500">Loading...</span> }}
      />
    </div>
  );
};

export default ProcessList;
