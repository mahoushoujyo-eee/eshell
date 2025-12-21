import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import useStore from '../store/useStore';

const SessionManager = () => {
  const [sessionsStatus, setSessionsStatus] = useState([]);
  const { sessions, terminals, removeTerminal, activeTerminalId, setActiveTerminalId, markSessionDisconnected } = useStore();

  // 定期获取所有会话状态
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const status = await invoke('get_sessions_status');
        setSessionsStatus(status);
      } catch (err) {
        console.error('Failed to fetch sessions status:', err);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000); // 每3秒更新一次

    // 监听session关闭事件
    const unlistenPromises = sessions.map(session => 
      listen(`ssh_closed_${session.id}`, () => {
        markSessionDisconnected(session.id);
      })
    );

    return () => {
      clearInterval(interval);
      Promise.all(unlistenPromises).then(unlisteners => {
        unlisteners.forEach(unlisten => unlisten());
      });
    };
  }, [sessions, markSessionDisconnected]);

  const handleCloseSession = async (sessionId) => {
    try {
      await invoke('close_session', { id: sessionId });
      // 移除相关的终端标签
      terminals.filter(t => t.sessionId === sessionId).forEach(t => {
        removeTerminal(t.id);
      });
    } catch (err) {
      console.error('Failed to close session:', err);
    }
  };

  const handleReconnect = async (sessionId) => {
    try {
      await invoke('reconnect_session', { id: sessionId });
    } catch (err) {
      console.error('Failed to reconnect:', err);
    }
  };

  const handleCleanup = async () => {
    try {
      const count = await invoke('cleanup_sessions');
      console.log(`Cleaned up ${count} dead sessions`);
    } catch (err) {
      console.error('Failed to cleanup:', err);
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return `${diff}秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    return date.toLocaleString('zh-CN');
  };

  return (
    <div className="p-4 bg-gray-800 rounded-lg">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-white">会话管理器</h2>
        <button
          onClick={handleCleanup}
          className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-sm rounded"
        >
          清理死会话
        </button>
      </div>

      <div className="space-y-2">
        {sessionsStatus.map(status => {
          const session = sessions.find(s => s.id === status.id);
          const sessionTerminals = terminals.filter(t => t.sessionId === status.id);

          return (
            <div
              key={status.id}
              className="p-3 bg-gray-700 rounded border border-gray-600"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">
                      {session?.name || session?.host || status.id}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      status.connected ? 'bg-green-600' : 'bg-red-600'
                    }`}>
                      {status.connected ? '已连接' : '未连接'}
                    </span>
                    <span className={`px-2 py-0.5 text-xs rounded ${
                      status.active ? 'bg-blue-600' : 'bg-gray-600'
                    }`}>
                      {status.active ? '活跃' : '空闲'}
                    </span>
                  </div>
                  
                  <div className="mt-2 text-sm text-gray-300 space-y-1">
                    <div>线程ID: {status.thread_id}</div>
                    <div>最后活动: {formatTime(status.last_activity)}</div>
                    <div>标签页数: {sessionTerminals.length}</div>
                    {sessionTerminals.length > 0 && (
                      <div className="text-xs text-gray-400">
                        标签: {sessionTerminals.map(t => t.title).join(', ')}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  {!status.connected && (
                    <button
                      onClick={() => handleReconnect(status.id)}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded"
                    >
                      重连
                    </button>
                  )}
                  <button
                    onClick={() => handleCloseSession(status.id)}
                    className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-sm rounded"
                  >
                    关闭
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {sessionsStatus.length === 0 && (
          <div className="text-center text-gray-400 py-8">
            暂无活跃会话
          </div>
        )}
      </div>

      <div className="mt-4 p-3 bg-gray-900 rounded text-xs text-gray-400">
        <div className="font-semibold mb-1">说明：</div>
        <ul className="list-disc list-inside space-y-1">
          <li>每个SSH会话在独立的线程中运行</li>
          <li>切换标签页时，后台会话继续保持活跃</li>
          <li>系统会自动发送keepalive保持连接</li>
          <li>可以同时维护多个SSH会话</li>
        </ul>
      </div>
    </div>
  );
};

export default SessionManager;
