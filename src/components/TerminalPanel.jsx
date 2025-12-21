import React from 'react';
import { Tabs } from 'antd';
import useStore from '../store/useStore';
import Terminal from './Terminal';

const TerminalPanel = () => {
  const { terminals, activeTerminalId, setActiveTerminalId, removeTerminal } = useStore();

  const onChange = (newActiveKey) => {
    setActiveTerminalId(newActiveKey);
  };

  const onEdit = (targetKey, action) => {
    if (action === 'remove') {
      removeTerminal(targetKey);
    }
  };

  return (
    <div className="h-full w-full bg-[#1e1e1e] flex flex-col">
      {terminals.length === 0 ? (
        <div className="flex items-center justify-center h-full text-gray-500">
          Select a server to connect
        </div>
      ) : (
        <Tabs
          type="editable-card"
          onChange={onChange}
          activeKey={activeTerminalId}
          onEdit={onEdit}
          items={terminals.map(t => ({
            label: t.title,
            key: t.id,
            children: <Terminal terminalId={t.id} sessionId={t.sessionId} />,
            closable: true
          }))}
          className="h-full custom-tabs"
        />
      )}
    </div>
  );
};

export default TerminalPanel;
