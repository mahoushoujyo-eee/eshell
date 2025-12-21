import React, { useState, useEffect } from 'react';
import { Tree, Spin } from 'antd';
import { FolderOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import useStore from '../store/useStore';

const FileTree = ({ onSelect }) => {
  const { activeSessionId } = useStore();
  const [treeData, setTreeData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!activeSessionId) {
      setIsConnected(false);
      setTreeData([]);
      return;
    }

    setIsConnected(false);
    setTreeData([]);

    const unlistenPromise = listen(`ssh_connected_${activeSessionId}`, () => {
      setIsConnected(true);
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, [activeSessionId]);

  useEffect(() => {
    if (activeSessionId && isConnected) {
      loadRootTree();
    }
  }, [activeSessionId, isConnected]);

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
        icon: <FolderOutlined />,
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
