import React, { useState } from 'react';
import { Tabs } from 'antd';
import useStore from '../store/useStore';
import Terminal from './Terminal';
import SessionManager from './SessionManager';

const TerminalPanel = () => {
  const { terminals, activeTerminalId, setActiveTerminalId, removeTerminal, setActiveSessionId } = useStore();
  const [showSessionManager, setShowSessionManager] = useState(false);

  const onChange = (newActiveKey) => {
    if (newActiveKey === 'session-manager') {
      setShowSessionManager(true);
    } else {
      setShowSessionManager(false);
      setActiveTerminalId(newActiveKey);
      
      // 找到对应的terminal并更新activeSessionId
      const terminal = terminals.find(t => t.id === newActiveKey);
      if (terminal) {
        setActiveSessionId(terminal.sessionId);
      }
    }
  };

  const onEdit = (targetKey, action) => {
    if (action === 'remove') {
      removeTerminal(targetKey);
    }
  };

  const tabItems = [
    ...terminals.map(t => ({
      label: t.title,
      key: t.id,
      children: <Terminal terminalId={t.id} sessionId={t.sessionId} />,
      closable: true
    })),
    {
      label: '📊 会话管理',
      key: 'session-manager',
      children: <SessionManager />,
      closable: false
    }
  ];

  return (
    <div className="h-full w-full bg-[#1e1e1e] flex flex-col">
      {terminals.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-4">
          <div>选择一个服务器连接</div>
          <button
            onClick={() => onChange('session-manager')}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
          >
            查看会话管理器
          </button>
        </div>
      ) : (
        <Tabs
          type="editable-card"
          onChange={onChange}
          activeKey={showSessionManager ? 'session-manager' : activeTerminalId}
          onEdit={onEdit}
          items={tabItems}
          className="h-full custom-tabs"
        />
      )}
    </div>
  );
};

export default TerminalPanel;
