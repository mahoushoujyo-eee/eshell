import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const DiskUsage = ({ terminalId }) => {
  const { activeSessionId, getTabCache, setTabCache, connectedSessions } = useStore();
  const [disks, setDisks] = useState([]);
  const isSessionConnected = connectedSessions[activeSessionId] === true;

  useEffect(() => {
    if (!activeSessionId || !terminalId || !isSessionConnected) return;
    
    // 先尝试从缓存加载数据
    const cache = getTabCache(terminalId);
    if (cache && cache.diskUsage) {
      setDisks(cache.diskUsage);
    }
    
    // 然后异步刷新最新数据
    const fetchDiskUsage = async () => {
      try {
        const result = await invoke('get_disk_usage', {
          sessionId: activeSessionId
        });
        setDisks(result);
        
        // 保存到缓存
        setTabCache(terminalId, 'diskUsage', result);
      } catch (e) {
        console.error('Failed to get disk usage:', e);
      }
    };

    fetchDiskUsage();
    const interval = setInterval(fetchDiskUsage, 10000); // 每10秒更新一次

    return () => clearInterval(interval);
  }, [activeSessionId, terminalId, isSessionConnected]);

  if (!activeSessionId) {
    return null;
  }

  if (disks.length === 0) {
    return (
      <div className="text-[var(--text-secondary)] text-xs text-center py-2">
        Loading disk info...
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <style>{`
        .disk-table {
          font-size: 11px;
        }
        .disk-table th,
        .disk-table td {
          padding: 2px 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .disk-table::-webkit-scrollbar {
          width: 4px;
          height: 4px;
        }
        .disk-table::-webkit-scrollbar-track {
          background: transparent;
        }
        .disk-table::-webkit-scrollbar-thumb {
          background: var(--border-color);
          border-radius: 2px;
        }
        .disk-table::-webkit-scrollbar-thumb:hover {
          background: var(--text-secondary);
        }
      `}</style>
      <table className="disk-table w-full text-[var(--text-primary)] border-collapse">
        <thead>
          <tr className="text-[var(--text-secondary)] border-b border-[var(--border-color)]">
            <th className="text-left" style={{ minWidth: '60px' }}>Path</th>
            <th className="text-right" style={{ minWidth: '55px' }}>Avail/Size</th>
            <th className="text-right" style={{ minWidth: '35px' }}>Usage</th>
          </tr>
        </thead>
        <tbody>
          {disks.map((disk, index) => (
            <tr key={index} className="border-b border-[var(--border-color)] hover:bg-[var(--bg-secondary)]">
              <td className="text-left" title={disk.mounted_on}>
                {disk.mounted_on.length > 15 ? `${disk.mounted_on.substring(0, 15)}...` : disk.mounted_on}
              </td>
              <td className="text-right text-green-400">{disk.available}/{disk.size}</td>
              <td className="text-right">
                <span className={`${
                  parseInt(disk.use_percent) > 80 ? 'text-red-400' : 
                  parseInt(disk.use_percent) > 60 ? 'text-yellow-400' : 'text-blue-400'
                }`}>
                  {disk.use_percent}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default DiskUsage;
