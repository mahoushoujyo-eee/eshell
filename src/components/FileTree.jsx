import React, { useState, useEffect } from 'react';
import { Tree, Spin, Button } from 'antd';
import { FolderOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import useStore from '../store/useStore';

const FileTree = ({ onSelect, terminalId }) => {
  const { activeSessionId, getTabCache, setTabCache, connectedSessions } = useStore();
  const [treeData, setTreeData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    setIsConnected(connectedSessions[activeSessionId] === true);
  }, [activeSessionId, connectedSessions]);

  useEffect(() => {
    if (activeSessionId && isConnected && terminalId) {
      // 先尝试从缓存加载数据
      const cache = getTabCache(terminalId);
      if (cache && cache.fileTree) {
        setTreeData(cache.fileTree);
      }
      // 自动加载文件树
      loadRootTree();
    }
  }, [activeSessionId, isConnected, terminalId]);

  const loadRootTree = async () => {
    setLoading(true);
    try {
      const files = await invoke('list_files', {
        sessionId: activeSessionId,
        path: '/'
      });
      
      const rootNode = {
        title: '/',
        key: '/',
        icon: <FolderOpenOutlined />, // 使用打开文件夹图标
        children: files
          .filter(f => f.is_dir)
          .map(f => ({
            title: f.name,
            key: `/${f.name}`,
            icon: <FolderOutlined />,
            isLeaf: false
          }))
      };
      
      const rootTreeData = [rootNode];
      setTreeData(rootTreeData);
      
      // 保存到缓存
      if (terminalId) {
        setTabCache(terminalId, 'fileTree', rootTreeData);
      }
      
      // 自动加载根目录的子节点（展开根目录）
      onLoadData(rootNode);
    } catch (error) {
      console.error('Failed to load file tree:', error);
    } finally {
      setLoading(false);
    }
  };

  const onLoadData = async (node) => {
    if (node.children) {
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

      setTreeData(origin =>
        updateTreeData(origin, node.key, children)
      );
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

  const handleSelect = (selectedKeys) => {
    if (selectedKeys.length > 0 && onSelect) {
      onSelect(selectedKeys[0]);
    }
  };

  if (!activeSessionId) {
    return (
      <div className="p-4 text-gray-500 text-sm text-center">
        Connect to a server to browse files
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="p-4 text-gray-500 text-sm text-center">
        <Spin size="small" /> Connecting...
      </div>
    );
  }

  return (
    <div className="p-2 h-full overflow-auto custom-scrollbar">
      <div className="mb-2">
        <Button 
          size="small" 
          icon={<FolderOpenOutlined />} 
          onClick={loadRootTree}
          className="w-full"
        >
          Load File Tree
        </Button>
      </div>
      {loading ? (
        <div className="text-center text-gray-500">
          <Spin size="small" />
        </div>
      ) : (
        <Tree
          showIcon
          loadData={onLoadData}
          treeData={treeData}
          onSelect={handleSelect}
          className="bg-transparent text-gray-300"
        />
      )}
    </div>
  );
};

export default FileTree;
