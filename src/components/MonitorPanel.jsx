import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import useStore from '../store/useStore';

const MonitorPanel = () => {
  const { activeSessionId } = useStore();
  const [data, setData] = useState([]);
  const [currentStats, setCurrentStats] = useState(null);

  useEffect(() => {
    if (!activeSessionId) return;
    
    const interval = setInterval(async () => {
      try {
        const stats = await invoke('get_system_stats', {
          sessionId: activeSessionId
        });
        setCurrentStats(stats);
        setData(prev => {
          const newData = [...prev, { ...stats, time: new Date().toLocaleTimeString() }];
          if (newData.length > 20) newData.shift();
          return newData;
        });
      } catch (e) {
        console.error(e);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeSessionId]);

  if (!currentStats) return <div className="text-white p-4">Loading stats...</div>;

  return (
    <div className="h-full flex bg-[#1e1e1e] text-white p-2 gap-4">
      <div className="w-1/4 flex flex-col gap-2">
        <div className="bg-[#2d2d2d] p-2 rounded">
          <div className="text-gray-400 text-xs">CPU Usage</div>
          <div className="text-xl font-bold text-blue-400">{currentStats.cpu_usage.toFixed(1)}%</div>
        </div>
        <div className="bg-[#2d2d2d] p-2 rounded">
          <div className="text-gray-400 text-xs">Memory</div>
          <div className="text-xl font-bold text-green-400">
            {(currentStats.memory_usage / 1024 / 1024 / 1024).toFixed(2)} / {(currentStats.total_memory / 1024 / 1024 / 1024).toFixed(2)} GB
          </div>
        </div>
        <div className="bg-[#2d2d2d] p-2 rounded">
          <div className="text-gray-400 text-xs">Network RX/TX</div>
          <div className="text-sm font-bold text-yellow-400">
            {(currentStats.rx_bytes / 1024).toFixed(1)} KB/s / {(currentStats.tx_bytes / 1024).toFixed(1)} KB/s
          </div>
        </div>
      </div>
      <div className="flex-1 bg-[#2d2d2d] rounded p-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#444" />
            <XAxis dataKey="time" stroke="#888" fontSize={10} />
            <YAxis stroke="#888" fontSize={10} />
            <Tooltip contentStyle={{ backgroundColor: '#333', border: 'none' }} />
            <Line type="monotone" dataKey="cpu_usage" stroke="#8884d8" dot={false} />
            <Line type="monotone" dataKey="memory_usage" stroke="#82ca9d" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default MonitorPanel;
