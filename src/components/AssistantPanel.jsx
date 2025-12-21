import React, { useState } from 'react';
import { Tabs, Input, Button, Select, message } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const { TextArea } = Input;

const AssistantPanel = () => {
  const [activeTab, setActiveTab] = useState('chat');
  const [webUrl, setWebUrl] = useState('https://chatgpt.com');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState('');
  const { activeTerminalSelection } = useStore();

  const handleAskAi = async () => {
    if (!prompt) return;
    setLoading(true);
    try {
      const res = await invoke('ask_ai', {
        request: {
          prompt,
          context: activeTerminalSelection || "No context selected",
          config: {
            api_key: localStorage.getItem('openai_api_key') || '',
            base_url: localStorage.getItem('openai_base_url') || 'https://api.openai.com/v1',
            model: localStorage.getItem('openai_model') || 'gpt-3.5-turbo',
          }
        }
      });
      setResponse(res);
    } catch (error) {
      message.error(`AI Error: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const items = [
    {
      key: 'chat',
      label: 'AI Chat',
      children: (
        <div className="flex flex-col h-full p-2">
          <div className="flex-1 overflow-y-auto mb-2 border border-[#333] rounded p-2 bg-[#2d2d2d] text-white whitespace-pre-wrap font-mono text-sm">
            {response || <div className="text-gray-400 text-center mt-4">AI Assistant Ready. Select text in terminal for context.</div>}
          </div>
          <div className="flex gap-2">
            <TextArea 
              rows={2} 
              placeholder="Ask AI..." 
              className="bg-[#2d2d2d] text-white border-[#444]" 
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  handleAskAi();
                }
              }}
            />
            <Button type="primary" icon={<SendOutlined />} className="h-auto" onClick={handleAskAi} loading={loading} />
          </div>
        </div>
      ),
    },
    {
      key: 'web',
      label: 'Web',
      children: (
        <div className="flex flex-col h-full">
          <div className="p-2 flex gap-2">
            <Select 
              defaultValue="https://chatgpt.com" 
              style={{ width: '100%' }} 
              onChange={setWebUrl}
              options={[
                { value: 'https://chatgpt.com', label: 'ChatGPT' },
                { value: 'https://chat.deepseek.com', label: 'DeepSeek' },
                { value: 'https://claude.ai', label: 'Claude' },
              ]}
            />
          </div>
          <iframe src={webUrl} className="flex-1 w-full border-none bg-white" title="AI Web" />
        </div>
      ),
    },
  ];

  return (
    <div className="h-full bg-[#1e1e1e] border-l border-[#333]">
      <Tabs defaultActiveKey="chat" items={items} className="h-full custom-tabs" />
    </div>
  );
};

export default AssistantPanel;
