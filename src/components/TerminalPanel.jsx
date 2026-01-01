import React, { useState } from 'react';
import { Tabs } from 'antd';
import useStore from '../store/useStore';
import Terminal from './Terminal';

const TerminalPanel = () => {
  const { terminals, activeTerminalId, setActiveTerminalId, removeTerminal, setActiveSessionId } = useStore();

  const onChange = (newActiveKey) => {
    setActiveTerminalId(newActiveKey);
    
    // 找到对应的terminal并更新activeSessionId
    const terminal = terminals.find(t => t.id === newActiveKey);
    if (terminal) {
      setActiveSessionId(terminal.sessionId);
    }
  };

  const onEdit = (targetKey, action) => {
    if (action === 'remove') {
      removeTerminal(targetKey);
    }
  };

  const tabItems = terminals.map(t => ({
    label: t.title,
    key: t.id,
    children: <Terminal terminalId={t.id} sessionId={t.sessionId} />,
    closable: true
  }));

  return (
    <div className="h-full w-full flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      {terminals.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-[var(--text-secondary)]">
          <div>选择一个服务器连接</div>
        </div>
      ) : (
        <Tabs
          type="editable-card"
          onChange={onChange}
          activeKey={activeTerminalId}
          onEdit={onEdit}
          items={tabItems}
          className="h-full custom-tabs"
        />
      )}
    </div>
  );
};

export default TerminalPanel;
