import React, { useState } from 'react';
import { FolderOutlined, DesktopOutlined, PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { Menu, Button, Modal, Form, Input } from 'antd';
import useStore from '../store/useStore';
import { v4 as uuidv4 } from 'uuid';

const Sidebar = () => {
  const { sessions, addSession, addTerminal, setActiveSessionId } = useStore();
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
    <div className="h-full bg-[#252526] text-gray-300 flex flex-col border-r border-[#333]">
      <div className="p-3 flex justify-between items-center border-b border-[#333] bg-[#2d2d2d]">
        <span className="font-semibold text-sm tracking-wide uppercase text-gray-400">Servers</span>
        <Button type="text" size="small" icon={<PlusOutlined className="text-gray-400 hover:text-white" />} onClick={() => setIsModalOpen(true)} />
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        <Menu
          mode="inline"
          theme="dark"
          className="bg-transparent border-none"
          selectedKeys={[]}
          items={sessions.map(s => ({
            key: s.id,
            icon: <DesktopOutlined />,
            label: <span className="text-gray-300 hover:text-white">{s.name || s.host}</span>,
            onClick: () => handleConnect(s)
          }))}
        />
        {sessions.length === 0 && (
            <div className="p-4 text-center text-gray-500 text-xs">
                No servers added.
            </div>
        )}
      </div>

      <div className="p-2 border-t border-[#333] bg-[#2d2d2d]">
        <Button type="text" icon={<SettingOutlined className="text-gray-400" />} block className="text-left text-gray-400 hover:text-white">
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
