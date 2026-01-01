import React, { useState } from 'react';
import { Tabs, Input, Button, Select, message } from 'antd';
import { SendOutlined, CopyOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const { TextArea } = Input;

const AssistantPanel = () => {
  const [activeTab, setActiveTab] = useState('chat');
  const [webUrl, setWebUrl] = useState('https://chatgpt.com');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState('');
  const { activeTerminalSelection, theme } = useStore();

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
          <div className="flex-1 overflow-y-auto mb-2 border border-[var(--border-color)] rounded p-2 bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-mono text-sm">
            {response ? (
              <ReactMarkdown
                components={{
                  code({ node, inline, className, children, ...props }) {
                    return !inline ? (
                      <div className="relative group">
                        <pre className={`!p-3 rounded-md border overflow-x-auto my-2 ${
                          theme === 'dark' ? '!bg-[#1e1e1e] border-[#333]' : '!bg-[#f5f5f5] border-[#dcdcdc]'
                        }`}>
                          <code className={className} {...props}>
                            {children}
                          </code>
                        </pre>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(String(children));
                            message.success('Copied to clipboard');
                          }}
                          className={`absolute top-2 right-2 p-1.5 rounded border opacity-0 group-hover:opacity-100 transition-opacity ${
                            theme === 'dark' ? 'bg-[#2d2d2d] hover:bg-[#3d3d3d] border-[#444] text-gray-400' : 'bg-[#fff] hover:bg-[#f0f0f0] border-[#dcdcdc] text-gray-600'
                          }`}
                        >
                          <CopyOutlined />
                        </button>
                      </div>
                    ) : (
                      <code className={`${theme === 'dark' ? 'bg-[#2d2d2d] text-blue-400' : 'bg-[#f0f0f0] text-blue-600'} px-1 rounded`} {...props}>
                        {children}
                      </code>
                    );
                  }
                }}
              >
                {response}
              </ReactMarkdown>
            ) : (
              <div className="text-gray-400 text-center mt-4">AI Assistant Ready. Select text in terminal for context.</div>
            )}
          </div>
          <div className="flex gap-2">
            <TextArea 
              rows={2} 
              placeholder="Ask AI..." 
              className="bg-[var(--bg-tertiary)] text-[var(--text-primary)] border-[var(--border-color)]" 
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
          <iframe src={webUrl} className="flex-1 w-full border-none bg-[var(--bg-primary)]" title="AI Web" />
        </div>
      ),
    },
  ];

  return (
    <div className="h-full bg-[var(--bg-primary)] text-[var(--text-primary)] border-l border-[var(--border-color)]">
      <Tabs defaultActiveKey="chat" items={items} className="h-full custom-tabs" />
    </div>
  );
};

export default AssistantPanel;
