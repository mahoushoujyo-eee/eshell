import React, { useState, useEffect } from 'react';
import { List, Button, Modal, Input, message, Popconfirm } from 'antd';
import { PlayCircleOutlined, EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const { TextArea } = Input;

const ScriptManager = () => {
  const { activeSessionId } = useStore();
  const [scripts, setScripts] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingScript, setEditingScript] = useState(null);
  const [scriptName, setScriptName] = useState('');
  const [scriptContent, setScriptContent] = useState('');

  // 预置脚本
  const presetScripts = [
    {
      id: 'preset_1',
      name: 'System Info',
      content: 'uname -a\ncat /etc/os-release\ndf -h\nfree -h'
    },
    {
      id: 'preset_2',
      name: 'Network Check',
      content: 'ip addr\nping -c 4 8.8.8.8\nss -tuln'
    },
    {
      id: 'preset_3',
      name: 'Docker Status',
      content: 'docker ps -a\ndocker images\ndocker stats --no-stream'
    }
  ];

  useEffect(() => {
    loadScripts();
  }, []);

  const loadScripts = async () => {
    try {
      const config = await invoke('load_config');
      const savedScripts = config?.scripts || [];
      setScripts([...presetScripts, ...savedScripts]);
    } catch (e) {
      console.error('Failed to load scripts:', e);
      setScripts(presetScripts);
    }
  };

  const saveScripts = async (newScripts) => {
    const userScripts = newScripts.filter(s => !s.id.startsWith('preset_'));
    try {
      const config = await invoke('load_config') || {};
      const updatedConfig = {
        sessions: config.sessions || [],
        scripts: userScripts
      };
      await invoke('save_config', { config: updatedConfig });
    } catch (e) {
      console.error('Failed to save scripts:', e);
      message.error('Failed to save scripts');
    }
  };

  const handleAddScript = () => {
    setEditingScript(null);
    setScriptName('');
    setScriptContent('');
    setIsModalOpen(true);
  };

  const handleEditScript = (script) => {
    if (script.id.startsWith('preset_')) {
      message.warning('Cannot edit preset scripts. Create a copy instead.');
      return;
    }
    setEditingScript(script);
    setScriptName(script.name);
    setScriptContent(script.content);
    setIsModalOpen(true);
  };

  const handleSaveScript = () => {
    if (!scriptName || !scriptContent) {
      message.warning('Please fill in all fields');
      return;
    }

    let newScripts;
    if (editingScript) {
      newScripts = scripts.map(s => 
        s.id === editingScript.id 
          ? { ...s, name: scriptName, content: scriptContent }
          : s
      );
    } else {
      const newScript = {
        id: `user_${Date.now()}`,
        name: scriptName,
        content: scriptContent
      };
      newScripts = [...scripts, newScript];
    }

    setScripts(newScripts);
    saveScripts(newScripts);
    setIsModalOpen(false);
    message.success('Script saved');
  };

  const handleDeleteScript = (script) => {
    if (script.id.startsWith('preset_')) {
      message.warning('Cannot delete preset scripts');
      return;
    }
    const newScripts = scripts.filter(s => s.id !== script.id);
    setScripts(newScripts);
    saveScripts(newScripts);
    message.success('Script deleted');
  };

  const handleRunScript = async (script) => {
    if (!activeSessionId) {
      message.warning('Please connect to a server first');
      return;
    }

    try {
      const commands = script.content.split('\n').filter(c => c.trim());
      for (const cmd of commands) {
        await invoke('send_command', {
          id: activeSessionId,
          command: cmd + '\n'
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      message.success(`Script "${script.name}" executed`);
    } catch (e) {
      message.error(`Failed to run script: ${e}`);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)] p-4 overflow-hidden">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">Script Manager</h3>
        <Button 
          type="primary" 
          icon={<PlusOutlined />} 
          size="small"
          onClick={handleAddScript}
        >
          New Script
        </Button>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <List
          dataSource={scripts}
          renderItem={script => (
            <List.Item
              className="border-b border-[var(--border-color)] hover:bg-[var(--bg-tertiary)] px-2"
              actions={[
                <Button
                  key="run"
                  type="text"
                  icon={<PlayCircleOutlined />}
                  size="small"
                  onClick={() => handleRunScript(script)}
                  disabled={!activeSessionId}
                  className="text-green-500"
                />,
                !script.id.startsWith('preset_') && (
                  <Button
                    key="edit"
                    type="text"
                    icon={<EditOutlined />}
                    size="small"
                    onClick={() => handleEditScript(script)}
                    className="text-blue-500"
                  />
                ),
                !script.id.startsWith('preset_') && (
                  <Popconfirm
                    key="delete"
                    title="Delete this script?"
                    onConfirm={() => handleDeleteScript(script)}
                  >
                    <Button
                      type="text"
                      icon={<DeleteOutlined />}
                      size="small"
                      className="text-red-500"
                    />
                  </Popconfirm>
                )
              ].filter(Boolean)}
            >
              <List.Item.Meta
                title={
                  <span className="text-[var(--text-primary)]">
                    {script.name}
                    {script.id.startsWith('preset_') && (
                      <span className="ml-2 text-xs text-gray-500">(Preset)</span>
                    )}
                  </span>
                }
                description={
                  <span className="text-gray-400 text-xs">
                    {script.content.split('\n')[0]}...
                  </span>
                }
              />
            </List.Item>
          )}
        />
      </div>

      <Modal
        title={editingScript ? 'Edit Script' : 'New Script'}
        open={isModalOpen}
        onOk={handleSaveScript}
        onCancel={() => setIsModalOpen(false)}
        width={600}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm mb-1">Name</label>
            <Input
              value={scriptName}
              onChange={e => setScriptName(e.target.value)}
              placeholder="Script name"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Commands (one per line)</label>
            <TextArea
              value={scriptContent}
              onChange={e => setScriptContent(e.target.value)}
              placeholder="ls -la&#10;ps aux&#10;df -h"
              rows={10}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default ScriptManager;
