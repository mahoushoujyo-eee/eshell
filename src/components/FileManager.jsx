import React, { useState, useEffect } from 'react';
import { Table, Button, Breadcrumb, Modal, Input, message, Upload, Tree, Spin, Dropdown } from 'antd';
import { FileOutlined, FolderOutlined, UploadOutlined, PlusOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import useStore from '../store/useStore';
import FileEditor from './FileEditor';

const FileManager = ({ initialPath = '/', terminalId }) => {
  const { activeSessionId, getTabCache, setTabCache, connectedSessions } = useStore();
  const [files, setFiles] = useState([]);
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [pathParts, setPathParts] = useState(['/']);
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [newFolderModalOpen, setNewFolderModalOpen] = useState(false);
  const [newFileModalOpen, setNewFileModalOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [renamingFile, setRenamingFile] = useState(null);
  const [renameNewName, setRenameNewName] = useState('');
  const [treeData, setTreeData] = useState([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [rightClickNodeKey, setRightClickNodeKey] = useState(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingFile, setEditingFile] = useState(null);
  const [editorContent, setEditorContent] = useState('');

  useEffect(() => {
    if (initialPath && initialPath !== currentPath && isConnected) {
      setCurrentPath(initialPath);
      setPathParts(initialPath.split('/').filter(p => p));
    }
  }, [initialPath, isConnected]);

  useEffect(() => {
    setIsConnected(connectedSessions[activeSessionId] === true);
  }, [activeSessionId, connectedSessions]);

  useEffect(() => {
    if (activeSessionId && isConnected && terminalId) {
      // 先尝试从缓存加载数据
      const cache = getTabCache(terminalId);
      if (cache && cache.fileManager) {
        const { currentPath: cachedPath, files: cachedFiles, treeData: cachedTree } = cache.fileManager;
        setCurrentPath(cachedPath || currentPath);
        setFiles(cachedFiles || []);
        setTreeData(cachedTree || []);
      }
      // 自动加载文件列表
      loadFiles(currentPath);
      loadRootTree();
    }
  }, [activeSessionId, isConnected, terminalId]);

  const loadRootTree = async () => {
    if (!activeSessionId || !terminalId) return;
    setTreeLoading(true);
    try {
      const files = await invoke('list_files', {
        sessionId: activeSessionId,
        path: '/'
      });
      
      const rootNode = {
        title: '/',
        key: '/',
        icon: <FolderOpenOutlined />,
        children: files
          .filter(f => f.is_dir)
          .map(f => ({
            title: f.name,
            key: `/${f.name}`,
            icon: <FolderOutlined />,
            isLeaf: false
          }))
      };
      
      setTreeData([rootNode]);
      
      // 保存到缓存
      const cache = getTabCache(terminalId);
      setTabCache(terminalId, 'fileManager', {
        currentPath: cache?.fileManager?.currentPath || currentPath,
        files: cache?.fileManager?.files || files,
        treeData: [rootNode]
      });
      
      // 不再自动加载根目录的子节点
    } catch (error) {
      console.error('Failed to load file tree:', error);
    } finally {
      setTreeLoading(false);
    }
  };

  const onLoadTreeData = async (node) => {
    if (node.children || !activeSessionId || !terminalId) {
      return;
    }

    try {
      const files = await invoke('list_files', {
        sessionId: activeSessionId,
        path: node.key
      });

      const children = files
        .filter(f => f.is_dir)
        .map(f => ({
          title: f.name,
          key: `${node.key}/${f.name}`.replace('//', '/'),
          icon: <FolderOutlined />,
          isLeaf: false
        }));

      const newTreeData = updateTreeData(treeData, node.key, children);
      setTreeData(newTreeData);
      
      // 保存到缓存
      const cache = getTabCache(terminalId);
      setTabCache(terminalId, 'fileManager', {
        currentPath: cache?.fileManager?.currentPath || currentPath,
        files: cache?.fileManager?.files || files,
        treeData: newTreeData
      });
    } catch (error) {
      console.error('Failed to load directory:', error);
    }
  };

  const updateTreeData = (list, key, children) => {
    return list.map(node => {
      if (node.key === key) {
        return { ...node, children };
      }
      if (node.children) {
        return {
          ...node,
          children: updateTreeData(node.children, key, children)
        };
      }
      return node;
    });
  };

  const handleTreeSelect = (selectedKeys) => {
    if (selectedKeys.length > 0) {
      const path = selectedKeys[0];
      setCurrentPath(path);
      setPathParts(path.split('/').filter(p => p));
      // 当用户点击树节点时，加载对应目录的文件列表
      loadFiles(path);
    }
  };

  const refreshTreeNode = async (nodeKey) => {
    if (!activeSessionId) return;
    
    try {
      const files = await invoke('list_files', {
        sessionId: activeSessionId,
        path: nodeKey
      });

      const children = files
        .filter(f => f.is_dir)
        .map(f => ({
          title: f.name,
          key: `${nodeKey}/${f.name}`.replace('//', '/'),
          icon: <FolderOutlined />,
          isLeaf: false
        }));

      setTreeData(origin =>
        updateTreeData(origin, nodeKey, children)
      );
      message.success('目录已刷新');
    } catch (error) {
      message.error(`刷新失败: ${error}`);
    }
  };

  const handleRightClick = ({ node }) => {
    setRightClickNodeKey(node.key);
  };

  const getTreeContextMenu = () => [
    {
      key: 'refresh',
      icon: <ReloadOutlined />,
      label: '刷新',
      onClick: () => {
        if (rightClickNodeKey) {
          refreshTreeNode(rightClickNodeKey);
        }
      }
    }
  ];

  const loadFiles = async (path) => {
    if (!activeSessionId || !terminalId) return;
    setLoading(true);
    try {
      const result = await invoke('list_files', {
        sessionId: activeSessionId,
        path: path
      });
      setFiles(result);
      
      // 保存到缓存
      const cache = getTabCache(terminalId);
      setTabCache(terminalId, 'fileManager', {
        currentPath: path,
        files: result,
        treeData: cache?.fileManager?.treeData || treeData
      });
    } catch (error) {
      message.error(`Failed to load files: ${error}`);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  const handleNavigate = (record) => {
    if (record.is_dir) {
      const newPath = currentPath === '/' ? `/${record.name}` : `${currentPath}/${record.name}`;
      setCurrentPath(newPath);
      setPathParts(newPath.split('/').filter(p => p));
      // 当用户点击文件列表中的目录时，加载对应目录的文件列表
      loadFiles(newPath);
    }
  };

  const handleBreadcrumbClick = (index) => {
    let newPath;
    if (index === -1) {
      newPath = '/';
      setCurrentPath(newPath);
      setPathParts(['/']);
    } else {
      newPath = '/' + pathParts.slice(0, index + 1).join('/');
      setCurrentPath(newPath);
      setPathParts(pathParts.slice(0, index + 1));
    }
    // 当用户点击面包屑时，加载对应目录的文件列表
    loadFiles(newPath);
  };

  const handleCreateFolder = async () => {
    if (!newFolderName || !activeSessionId) return;
    try {
      const newPath = currentPath === '/' ? `/${newFolderName}` : `${currentPath}/${newFolderName}`;
      await invoke('create_directory', {
        sessionId: activeSessionId,
        path: newPath
      });
      message.success('Folder created');
      setNewFolderModalOpen(false);
      setNewFolderName('');
      loadFiles(currentPath);
      // 不再自动刷新目录树
    } catch (error) {
      message.error(`Failed to create folder: ${error}`);
    }
  };

  const handleCreateFile = async () => {
    if (!newFileName || !activeSessionId) return;
    try {
      const filePath = currentPath === '/' ? `/${newFileName}` : `${currentPath}/${newFileName}`;
      await invoke('upload_file', {
        sessionId: activeSessionId,
        remotePath: filePath,
        content: [] // Empty file
      });
      message.success('File created');
      setNewFileModalOpen(false);
      setNewFileName('');
      loadFiles(currentPath);
    } catch (error) {
      message.error(`Failed to create file: ${error}`);
    }
  };

  const handleDelete = async (record) => {
    if (!activeSessionId) return;
    Modal.confirm({
      title: `Delete ${record.name}?`,
      content: record.is_dir ? 'This will delete the directory and all its contents.' : 'This file will be deleted.',
      onOk: async () => {
        try {
          const fullPath = currentPath === '/' ? `/${record.name}` : `${currentPath}/${record.name}`;
          await invoke('delete_file', {
            sessionId: activeSessionId,
            path: fullPath,
            isDir: record.is_dir
          });
          message.success('Deleted');
          loadFiles(currentPath);
        } catch (error) {
          message.error(`Failed to delete: ${error}`);
        }
      }
    });
  };

  const handleRename = async () => {
    if (!renameNewName || !renamingFile || !activeSessionId) return;
    try {
      const oldPath = currentPath === '/' ? `/${renamingFile.name}` : `${currentPath}/${renamingFile.name}`;
      const newPath = currentPath === '/' ? `/${renameNewName}` : `${currentPath}/${renameNewName}`;
      await invoke('rename_file', {
        sessionId: activeSessionId,
        oldPath,
        newPath
      });
      message.success('Renamed');
      setRenameModalOpen(false);
      setRenamingFile(null);
      setRenameNewName('');
      loadFiles(currentPath);
    } catch (error) {
      message.error(`Failed to rename: ${error}`);
    }
  };

  const handleDownload = async (record) => {
    if (!activeSessionId) return;
    try {
      const fullPath = currentPath === '/' ? `/${record.name}` : `${currentPath}/${record.name}`;
      const content = await invoke('download_file', {
        sessionId: activeSessionId,
        remotePath: fullPath
      });
      
      console.log('Downloaded content type:', typeof content);
      console.log('Downloaded content length:', content?.length);
      
      const savePath = await save({
        defaultPath: record.name,
      });
      
      if (savePath) {
        const uint8Array = new Uint8Array(content);
        const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = record.name;
        a.click();
        URL.revokeObjectURL(url);
        message.success('Downloaded');
      }
    } catch (error) {
      console.error('Download error:', error);
      message.error({
        content: `Failed to download ${record.name}: ${error}`,
        duration: 8
      });
    }
  };

  const handleUpload = async (file) => {
    if (!activeSessionId) return false;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const content = Array.from(new Uint8Array(arrayBuffer));
      const remotePath = currentPath === '/' ? `/${file.name}` : `${currentPath}/${file.name}`;
      
      await invoke('upload_file', {
        sessionId: activeSessionId,
        remotePath,
        content
      });
      
      message.success('Uploaded');
      loadFiles(currentPath);
    } catch (error) {
      message.error(`Failed to upload: ${error}`);
    }
    return false;
  };

  const handleEditFile = async (record) => {
    if (!activeSessionId || record.is_dir) return;
    try {
      const fullPath = currentPath === '/' ? `/${record.name}` : `${currentPath}/${record.name}`;
      const content = await invoke('download_file', {
        sessionId: activeSessionId,
        remotePath: fullPath
      });
      
      const uint8Array = new Uint8Array(content);
      const decoder = new TextDecoder('utf-8');
      const textContent = decoder.decode(uint8Array);
      
      setEditingFile(record);
      setEditorContent(textContent);
      setEditorVisible(true);
    } catch (error) {
      console.error('Edit error:', error);
      message.error({
        content: `Failed to open ${record.name} for editing: ${error}`,
        duration: 8
      });
    }
  };

  const handleSaveFile = async (content) => {
    if (!activeSessionId || !editingFile) return;
    try {
      const encoder = new TextEncoder();
      const uint8Array = encoder.encode(content);
      const arrayContent = Array.from(uint8Array);
      
      const fullPath = currentPath === '/' ? `/${editingFile.name}` : `${currentPath}/${editingFile.name}`;
      
      await invoke('upload_file', {
        sessionId: activeSessionId,
        remotePath: fullPath,
        content: arrayContent
      });
      
      message.success(`Saved ${editingFile.name}`);
      setEditorVisible(false);
      loadFiles(currentPath);
    } catch (error) {
      console.error('Save error:', error);
      message.error({
        content: `Failed to save ${editingFile.name}: ${error}`,
        duration: 8
      });
    }
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (text, record) => (
        <span 
          className="cursor-pointer hover:text-blue-400" 
          onClick={() => handleNavigate(record)}
          onDoubleClick={() => handleEditFile(record)}
        >
          {record.is_dir ? <FolderOutlined className="mr-2 text-yellow-500" /> : <FileOutlined className="mr-2 text-blue-400" />}
          {text}
        </span>
      ),
    },
    { 
      title: 'Size', 
      dataIndex: 'size', 
      key: 'size',
      render: (size, record) => record.is_dir ? '-' : formatSize(size)
    },
    { 
      title: 'Permissions', 
      dataIndex: 'permissions', 
      key: 'permissions',
      render: (perm) => perm ? perm : '-'
    },
    { 
      title: 'Modified', 
      dataIndex: 'modified', 
      key: 'modified',
      render: (time) => time ? new Date(time * 1000).toLocaleString() : '-'
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <div className="space-x-2">
          {!record.is_dir && (
            <Button 
              type="text" 
              size="small" 
              icon={<DownloadOutlined />} 
              onClick={() => handleDownload(record)}
            />
          )}
          <Button 
            type="text" 
            size="small" 
            icon={<EditOutlined />} 
            onClick={() => {
              setRenamingFile(record);
              setRenameNewName(record.name);
              setRenameModalOpen(true);
            }}
          />
          <Button 
            type="text" 
            size="small" 
            danger 
            icon={<DeleteOutlined />} 
            onClick={() => handleDelete(record)}
          />
        </div>
      ),
    },
  ];

  const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const breadcrumbItems = [
    { title: <span className="cursor-pointer" onClick={() => handleBreadcrumbClick(-1)}>Root</span> },
    ...pathParts.filter(p => p !== '/').map((part, index) => ({
      title: <span className="cursor-pointer" onClick={() => handleBreadcrumbClick(index)}>{part}</span>
    }))
  ];

  if (!activeSessionId) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        Connect to a server to browse files
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        Connecting to server...
      </div>
    );
  }

  return (
    <div className="h-full flex bg-[#1e1e1e] text-white">
      {/* 左侧目录树 */}
      <div className="w-64 border-r border-[#333] bg-[#252526] flex flex-col">
        <div className="px-3 py-2 text-gray-400 text-xs font-semibold uppercase tracking-wide border-b border-[#333]">
          Directory
        </div>
        <div className="flex-1 overflow-auto p-2 custom-scrollbar">
          {treeLoading ? (
            <div className="text-center text-gray-500">
              <Spin size="small" />
            </div>
          ) : (
            <Dropdown
              menu={{ items: getTreeContextMenu() }}
              trigger={['contextMenu']}
            >
              <div>
                <Tree
                  showIcon
                  loadData={onLoadTreeData}
                  treeData={treeData}
                  onSelect={handleTreeSelect}
                  onRightClick={handleRightClick}
                  className="bg-transparent text-gray-300"
                />
              </div>
            </Dropdown>
          )}
        </div>
      </div>

      {/* 右侧文件详情 */}
      <div className="flex-1 flex flex-col p-2">
        <div className="flex justify-between items-center mb-2">
          <Breadcrumb items={breadcrumbItems} className="text-gray-300" />
          <div className="flex gap-2">
            <Button icon={<ReloadOutlined />} size="small" className="w-24" onClick={() => loadFiles(currentPath)}>
              Refresh
            </Button>
            <Upload beforeUpload={handleUpload} showUploadList={false}>
              <Button icon={<UploadOutlined />} size="small" className="w-24">Upload</Button>
            </Upload>
            <Button icon={<PlusOutlined />} size="small" className="w-24" onClick={() => setNewFileModalOpen(true)}>
              New File
            </Button>
            <Button icon={<PlusOutlined />} size="small" className="w-28" onClick={() => setNewFolderModalOpen(true)}>
              New Folder
            </Button>
          </div>
        </div>
        <Table 
          dataSource={files} 
          columns={columns} 
          pagination={false} 
          size="small" 
          loading={loading}
          rowKey="name"
          className="flex-1 overflow-auto custom-table"
        />

      <Modal 
        title="Create New Folder" 
        open={newFolderModalOpen} 
        onOk={handleCreateFolder} 
        onCancel={() => {
          setNewFolderModalOpen(false);
          setNewFolderName('');
        }}
      >
        <Input 
          placeholder="Folder name" 
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onPressEnter={handleCreateFolder}
        />
      </Modal>

      <Modal 
        title="Create New File" 
        open={newFileModalOpen} 
        onOk={handleCreateFile} 
        onCancel={() => {
          setNewFileModalOpen(false);
          setNewFileName('');
        }}
      >
        <Input 
          placeholder="File name" 
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          onPressEnter={handleCreateFile}
        />
      </Modal>

      <Modal 
        title="Rename" 
        open={renameModalOpen} 
        onOk={handleRename} 
        onCancel={() => {
          setRenameModalOpen(false);
          setRenamingFile(null);
          setRenameNewName('');
        }}
      >
        <Input 
          placeholder="New name" 
          value={renameNewName}
          onChange={(e) => setRenameNewName(e.target.value)}
          onPressEnter={handleRename}
        />
      </Modal>

      <FileEditor
        visible={editorVisible}
        onClose={() => setEditorVisible(false)}
        fileName={editingFile?.name}
        content={editorContent}
        onSave={handleSaveFile}
      />
      </div>
    </div>
  );
};

export default FileManager;
