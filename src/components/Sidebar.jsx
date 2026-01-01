import React, { useState } from 'react';
import { FolderOutlined, DesktopOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { Menu, Button, Modal, Form, Input } from 'antd';
import useStore from '../store/useStore';
import { v4 as uuidv4 } from 'uuid';

const Sidebar = () => {
  const { sessions, addSession, addTerminal, setActiveSessionId, theme } = useStore();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form] = Form.useForm();

  const handleAddSession = (values) => {
    // 确保端口号是数字类型
    const sessionData = {
      ...values,
      port: parseInt(values.port) || 22,
    };
    const newSession = { ...sessionData, id: uuidv4() };
    addSession(newSession);
    setIsModalOpen(false);
    form.resetFields();
  };

  const handleConnect = (session) => {
    setActiveSessionId(session.id);
    const termId = uuidv4();
    addTerminal({ id: termId, sessionId: session.id, title: session.name || session.host });
  };

  return (
    <div className="h-full bg-[var(--bg-primary)] text-[var(--text-primary)] flex flex-col border-r border-[var(--border-color)]">
      <div className="p-3 flex justify-between items-center border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <span className="font-semibold text-sm tracking-wide uppercase text-[var(--text-secondary)]">Servers</span>
        <Button type="text" size="small" icon={<PlusOutlined className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]" />} onClick={() => setIsModalOpen(true)} />
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <Menu
          mode="inline"
          theme={theme === 'dark' ? 'dark' : 'light'}
          className="bg-transparent border-none"
          selectedKeys={[]}
          items={sessions.map(s => ({
            key: s.id,
            icon: <DesktopOutlined />,
            label: <span className="text-[var(--text-primary)] hover:text-[var(--text-primary)]">{s.name || s.host}</span>,
            onClick: () => handleConnect(s)
          }))}
        />
        {sessions.length === 0 && (
            <div className="p-4 text-center text-[var(--text-secondary)] text-xs">
                No servers added.
            </div>
        )}
      </div>

      <div className="p-2 border-t border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <Button type="text" icon={<SettingOutlined className="text-[var(--text-secondary)]" />} block className="text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          Settings
        </Button>
      </div>

      <Modal 
        title="Add Server" 
        open={isModalOpen} 
        onOk={form.submit} 
        onCancel={() => setIsModalOpen(false)}
        okButtonProps={{ className: "bg-blue-600" }}
      >
        <Form form={form} onFinish={handleAddSession} layout="vertical">
          <Form.Item name="name" label="Name">
            <Input placeholder="My Server" />
          </Form.Item>
          <Form.Item name="host" label="Host" rules={[{ required: true, message: 'Host is required' }]}>
            <Input placeholder="192.168.1.1" />
          </Form.Item>
          <Form.Item name="port" label="Port" initialValue={22} rules={[{ required: true, message: 'Port is required' }]}>
            <Input type="number" min={1} max={65535} placeholder="22" />
          </Form.Item>
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username is required' }]}>
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item name="password" label="Password">
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Sidebar;
