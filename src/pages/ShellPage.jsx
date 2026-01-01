import React, { useState, useEffect, useCallback } from "react";
import Topbar from "../components/Topbar";
import LeftPanel from "../components/LeftPanel";
import ServerManager from "../components/ServerManager";
import TerminalPanel from "../components/TerminalPanel";
import FileManager from "../components/FileManager";
import AssistantPanel from "../components/AssistantPanel";
import ScriptManager from "../components/ScriptManager";
import CommandEditor from "../components/CommandEditor";
import { Layout, Tabs, Button } from "antd";
import { DatabaseOutlined, RobotOutlined } from "@ant-design/icons";
import useStore from "../store/useStore";

const { Content, Sider } = Layout;

function ShellPage() {
  const [showAssistant, setShowAssistant] = useState(false);
  const [showServerManager, setShowServerManager] = useState(false);
  const [leftSiderWidth, setLeftSiderWidth] = useState(250);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(window.innerHeight / 3);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingBottom, setIsResizingBottom] = useState(false);

  const loadSessions = useStore((state) => state.loadSessions);
  const activeTerminalId = useStore((state) => state.activeTerminalId);

  const startResizingLeft = useCallback((e) => {
    e.preventDefault();
    setIsResizingLeft(true);
  }, []);

  const startResizingBottom = useCallback((e) => {
    e.preventDefault();
    setIsResizingBottom(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizingLeft(false);
    setIsResizingBottom(false);
  }, []);

  const resize = useCallback(
    (e) => {
      if (isResizingLeft) {
        const newWidth = e.clientX;
        if (newWidth > 150 && newWidth < 600) {
          setLeftSiderWidth(newWidth);
        }
      } else if (isResizingBottom) {
        const newHeight = window.innerHeight - e.clientY;
        if (newHeight > 100 && newHeight < window.innerHeight * 0.8) {
          setBottomPanelHeight(newHeight);
        }
      }
    },
    [isResizingLeft, isResizingBottom]
  );

  useEffect(() => {
    if (isResizingLeft || isResizingBottom) {
      document.body.style.cursor = isResizingLeft ? 'col-resize' : 'row-resize';
      window.addEventListener("mousemove", resize);
      window.addEventListener("mouseup", stopResizing);
    } else {
      document.body.style.cursor = '';
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    }
    return () => {
      document.body.style.cursor = '';
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizingLeft, isResizingBottom, resize, stopResizing]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const bottomItems = [
    { key: 'files', label: 'Files', children: <FileManager terminalId={activeTerminalId} /> },
    { key: 'scripts', label: 'Scripts', children: <ScriptManager terminalId={activeTerminalId} /> },
    { key: 'commands', label: 'Commands', children: <CommandEditor terminalId={activeTerminalId} /> },
  ];

  return (
    <Layout className="h-screen w-screen overflow-hidden bg-[#1e1e1e] flex flex-col">
      <Topbar />
      
      <Layout className="flex-1 overflow-hidden">
      <ServerManager open={showServerManager} onClose={() => setShowServerManager(false)} />
      
        <Sider width={leftSiderWidth} className="border-r border-[#333] flex flex-col relative" style={{ background: '#252526' }}>
          <div className="p-2 border-b border-[#333] bg-[#2d2d2d] flex-shrink-0 space-y-2">
            <Button
              type="primary"
              icon={<DatabaseOutlined />}
              onClick={() => setShowServerManager(true)}
              block
              size="small"
            >
              Servers
            </Button>
            <Button
              type="default"
              icon={<RobotOutlined />}
              onClick={() => setShowAssistant(!showAssistant)}
              block
              size="small"
            >
              AI Assistant
            </Button>
          </div>
          <div className="flex-1 overflow-hidden">
            <LeftPanel />
          </div>

          {/* Resizer Handle */}
          <div
            onMouseDown={startResizingLeft}
            className={`absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 transition-colors ${isResizingLeft ? 'bg-[#1890ff]' : 'hover:bg-[#1890ff]'}`}
            style={{ marginRight: '-0.5px' }}
          >
            {/* Increase hit area for easier dragging */}
            <div className="absolute top-0 left-[-2px] right-[-2px] h-full" />
          </div>
        </Sider>
        <Layout className="bg-[#1e1e1e]">
          <Content className="flex flex-col h-full overflow-hidden">
            <div className="flex-1 overflow-hidden relative">
              <TerminalPanel />
            </div>
            
            <div 
              className="border-t border-[#333] bg-[#1e1e1e] relative flex flex-col"
              style={{ height: `${bottomPanelHeight}px` }}
            >
              {/* Vertical Resizer Handle */}
              <div
                onMouseDown={startResizingBottom}
                className={`absolute top-0 left-0 w-full h-1 cursor-row-resize z-10 transition-colors ${isResizingBottom ? 'bg-[#1890ff]' : 'hover:bg-[#1890ff]'}`}
                style={{ marginTop: '-0.5px' }}
              >
                {/* Increase hit area for easier dragging */}
                <div className="absolute top-[-2px] bottom-[-2px] left-0 w-full" />
              </div>

              <div className="flex-1 overflow-hidden">
                <Tabs items={bottomItems} defaultActiveKey="files" className="h-full custom-tabs-bottom" />
              </div>
            </div>
          </Content>
        {showAssistant && (
          <Sider width={350} className="border-l border-[#333]" style={{ background: '#1e1e1e' }}>
            <AssistantPanel />
          </Sider>
        )}
      </Layout>
      </Layout>
    </Layout>
  );
}

export default ShellPage;
