import React, { useState } from 'react';
import { Drawer, Button, Modal, Form, Input, Popconfirm } from 'antd';
import { DesktopOutlined, PlusOutlined, SettingOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import useStore from '../store/useStore';
import { v4 as uuidv4 } from 'uuid';

const ServerManager = ({ open, onClose }) => {
  const { sessions, addSession, updateSession, removeSession, addTerminal, setActiveSessionId } = useStore();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSession, setEditingSession] = useState(null);
  const [form] = Form.useForm();

  const handleAddSession = (values) => {
    if (editingSession) {
      updateSession({ ...values, id: editingSession.id });
    } else {
      const newSession = { ...values, id: uuidv4() };
      addSession(newSession);
    }
    setIsModalOpen(false);
    setEditingSession(null);
    form.resetFields();
  };

  const handleEditSession = (session) => {
    setEditingSession(session);
    form.setFieldsValue(session);
    setIsModalOpen(true);
  };

  const handleDeleteSession = (sessionId) => {
    removeSession(sessionId);
  };

  const handleAddNew = () => {
    setEditingSession(null);
    form.resetFields();
    setIsModalOpen(true);
  };

  const handleConnect = (session) => {
    setActiveSessionId(session.id);
    const termId = uuidv4();
    addTerminal({ id: termId, sessionId: session.id, title: session.name || session.host });
    onClose();
  };

  return (
    <>
      <Drawer
        title={
          <div className="flex justify-between items-center">
            <span>Server Manager</span>
            <Button 
              type="text" 
              size="small" 
              icon={<PlusOutlined />} 
              onClick={handleAddNew}
            />
          </div>
        }
        placement="left"
        onClose={onClose}
        open={open}
        width={300}
      >
        <div className="flex flex-col h-full">
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-1">
              {sessions.map(s => (
                <div key={s.id} className="flex items-center justify-between px-4 py-2 hover:bg-[#2d2d2d] rounded group">
                  <div className="flex items-center flex-1 cursor-pointer" onClick={() => handleConnect(s)}>
                    <DesktopOutlined className="mr-2 text-gray-400" />
                    <div className="flex-1">
                      <div className="text-gray-300 text-sm">{s.name || s.host}</div>
                      <div className="text-gray-500 text-xs">{s.username}@{s.host}:{s.port}</div>
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditSession(s);
                      }}
                      className="text-blue-400"
                    />
                    <Popconfirm
                      title="Delete this server?"
                      onConfirm={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(s.id);
                      }}
                      okText="Yes"
                      cancelText="No"
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={(e) => e.stopPropagation()}
                        className="text-red-400"
                      />
                    </Popconfirm>
                  </div>
                </div>
              ))}
            </div>
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
        </div>
      </Drawer>

      <Modal 
        title={editingSession ? "Edit Server" : "Add Server"}
        open={isModalOpen} 
        onOk={form.submit} 
        onCancel={() => {
          setIsModalOpen(false);
          setEditingSession(null);
        }}
        okButtonProps={{ className: "bg-blue-600" }}
      >
        <Form form={form} onFinish={handleAddSession} layout="vertical">
          <Form.Item name="name" label="Name">
            <Input placeholder="My Server" />
          </Form.Item>
          <Form.Item name="host" label="Host" rules={[{ required: true, message: 'Host is required' }]}>
            <Input placeholder="192.168.1.1" />
          </Form.Item>
          <Form.Item name="port" label="Port" initialValue={22}>
            <Input type="number" />
          </Form.Item>
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Username is required' }]}>
            <Input placeholder="root" />
          </Form.Item>
          <Form.Item name="password" label="Password">
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};

export default ServerManager;
