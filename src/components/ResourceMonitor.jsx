import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Progress, Select } from 'antd';
import useStore from '../store/useStore';

const ResourceMonitor = ({ terminalId }) => {
  const { activeSessionId, getTabCache, setTabCache, connectedSessions } = useStore();
  const [stats, setStats] = useState(null);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [networkSpeed, setNetworkSpeed] = useState({ rx: 0, tx: 0 });
  const lastNetworkData = useRef({});
  const lastUpdateTime = useRef(Date.now());
  const isSessionConnected = connectedSessions[activeSessionId] === true;

  useEffect(() => {
    if (!activeSessionId || !terminalId || !isSessionConnected) return;
    
    // 先尝试从缓存加载数据
    const cache = getTabCache(terminalId);
    if (cache && cache.resources) {
      setStats(cache.resources.stats);
      setSelectedNetwork(cache.resources.selectedNetwork);
      setNetworkSpeed(cache.resources.networkSpeed);
    }
    
    // 然后异步刷新最新数据
    loadResources();
    
    const interval = setInterval(() => {
      loadResources();
    }, 2000);

    return () => clearInterval(interval);
  }, [activeSessionId, terminalId, isSessionConnected]);
  
  const loadResources = async () => {
    if (!activeSessionId || !terminalId) return;
    try {
      const result = await invoke('get_system_stats', {
        sessionId: activeSessionId
      });
      
      // Calculate network speed
      const now = Date.now();
      const elapsed = (now - lastUpdateTime.current) / 1000; // seconds
      
      let updatedNetworkSpeed = networkSpeed;
      if (result.networks && result.networks.length > 0) {
        const currentNet = selectedNetwork ? 
          result.networks.find(n => n.name === selectedNetwork) : 
          result.networks[0];
        
        if (currentNet && lastNetworkData.current[currentNet.name] && elapsed > 0) {
          const lastData = lastNetworkData.current[currentNet.name];
          const rxDiff = currentNet.rx_bytes - lastData.rx_bytes;
          const txDiff = currentNet.tx_bytes - lastData.tx_bytes;
          
          updatedNetworkSpeed = {
            rx: Math.max(0, rxDiff / elapsed),
            tx: Math.max(0, txDiff / elapsed)
          };
          setNetworkSpeed(updatedNetworkSpeed);
        }
        
        // Store current data for next calculation
        const newLastData = {};
        result.networks.forEach(net => {
          newLastData[net.name] = { rx_bytes: net.rx_bytes, tx_bytes: net.tx_bytes };
        });
        lastNetworkData.current = newLastData;
      }
      
      lastUpdateTime.current = now;
      setStats(result);
      
      // Auto select first network
      if (!selectedNetwork && result.networks && result.networks.length > 0) {
        setSelectedNetwork(result.networks[0].name);
      }
      
      // 保存到缓存
      setTabCache(terminalId, 'resources', {
        stats: result,
        selectedNetwork,
        networkSpeed: updatedNetworkSpeed
      });
    } catch (e) {
      console.error(e);
    }
  };

  if (!activeSessionId) {
    return (
      <div className="p-4 text-gray-500 text-sm text-center">
        Connect to a server to view resources
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-4 text-gray-500 text-sm text-center">
        Loading...
      </div>
    );
  }

  const memoryPercent = (stats.memory_usage / stats.total_memory) * 100;
  const memoryUsedGB = (stats.memory_usage / 1024 / 1024 / 1024).toFixed(2);
  const memoryTotalGB = (stats.total_memory / 1024 / 1024 / 1024).toFixed(2);

  const currentNetwork = stats.networks?.find(n => n.name === selectedNetwork) || stats.networks?.[0];

  return (
    <div className="px-3 py-2 space-y-2">
      {/* CPU */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <span className="text-gray-400 text-xs">CPU</span>
          <span className="text-white text-xs font-semibold">{stats.cpu_usage.toFixed(1)}%</span>
        </div>
        <Progress 
          percent={parseFloat(stats.cpu_usage.toFixed(1))} 
          strokeColor="#1890ff"
          size="small"
          showInfo={false}
        />
      </div>

      {/* Memory */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <span className="text-gray-400 text-xs">MEMORY</span>
          <span className="text-white text-xs">{memoryUsedGB} GB / {memoryTotalGB} GB</span>
        </div>
        <Progress 
          percent={parseFloat(memoryPercent.toFixed(1))} 
          strokeColor="#52c41a"
          size="small"
          showInfo={false}
        />
      </div>

      {/* Network */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-gray-400 text-xs">NETWORK</span>
          {stats.networks && stats.networks.length > 1 && (
            <Select
              size="small"
              value={selectedNetwork}
              onChange={setSelectedNetwork}
              className="w-20"
              options={stats.networks.map(net => ({
                label: net.name,
                value: net.name
              }))}
            />
          )}
        </div>
        {currentNetwork && (
          <div className="space-y-0.5 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-400">RX:</span>
              <span className="text-green-400">{(networkSpeed.rx / 1024).toFixed(1)} KB/s</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">TX:</span>
              <span className="text-blue-400">{(networkSpeed.tx / 1024).toFixed(1)} KB/s</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ResourceMonitor;
