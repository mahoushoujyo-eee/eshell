import React, { useEffect, useState, useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { Modal, Button, message } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import useStore from '../store/useStore';

const FileEditor = ({ visible, onClose, fileName, content, onSave }) => {
  const { theme } = useStore();
  const [editorContent, setEditorContent] = useState('');
  const [language, setLanguage] = useState('plaintext');

  useEffect(() => {
    if (content) {
      setEditorContent(content);
    }
  }, [content]);

  useEffect(() => {
    if (fileName) {
      const ext = fileName.split('.').pop().toLowerCase();
      const langMap = {
        'js': 'javascript',
        'jsx': 'javascript',
        'ts': 'typescript',
        'tsx': 'typescript',
        'py': 'python',
        'java': 'java',
        'c': 'c',
        'cpp': 'cpp',
        'h': 'c',
        'hpp': 'cpp',
        'cs': 'csharp',
        'go': 'go',
        'rs': 'rust',
        'rb': 'ruby',
        'php': 'php',
        'swift': 'swift',
        'kt': 'kotlin',
        'scala': 'scala',
        'sh': 'shell',
        'bash': 'shell',
        'zsh': 'shell',
        'fish': 'shell',
        'ps1': 'powershell',
        'json': 'json',
        'xml': 'xml',
        'html': 'html',
        'htm': 'html',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'sass': 'sass',
        'sql': 'sql',
        'md': 'markdown',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'toml',
        'ini': 'ini',
        'cfg': 'ini',
        'conf': 'ini',
        'dockerfile': 'dockerfile',
        'dockerignore': 'plaintext',
        'gitignore': 'plaintext',
        'txt': 'plaintext',
        'log': 'plaintext'
      };
      setLanguage(langMap[ext] || 'plaintext');
    }
  }, [fileName]);

  const handleSave = useCallback(() => {
    onSave(editorContent);
  }, [editorContent, onSave]);

  const handleKeyDown = useCallback((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  useEffect(() => {
    if (visible) {
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [visible, handleKeyDown]);

  return (
    <Modal
      title={`编辑: ${fileName}`}
      open={visible}
      onCancel={onClose}
      width="90vw"
      style={{ top: 20, height: '90vh' }}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="save" type="primary" icon={<SaveOutlined />} onClick={handleSave}>
          保存 (Ctrl+S)
        </Button>
      ]}
      destroyOnClose
    >
      <div style={{ height: 'calc(90vh - 200px)', border: '1px solid #d9d9d9' }}>
        <Editor
          height="100%"
          language={language}
          value={editorContent}
          onChange={(value) => setEditorContent(value)}
          theme={theme === 'dark' ? 'vs-dark' : 'vs-light'}
          options={{
            minimap: { enabled: true },
            fontSize: 14,
            lineNumbers: 'on',
            roundedSelection: false,
            scrollBeyondLastLine: false,
            readOnly: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: 'on',
            formatOnPaste: true,
            formatOnType: true
          }}
        />
      </div>
    </Modal>
  );
};

export default FileEditor;