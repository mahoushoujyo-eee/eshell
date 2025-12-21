import React, { useState, useEffect } from "react";
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
  const loadSessions = useStore((state) => state.loadSessions);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const bottomItems = [
    { key: 'files', label: 'Files', children: <FileManager /> },
    { key: 'scripts', label: 'Scripts', children: <ScriptManager /> },
    { key: 'commands', label: 'Commands', children: <CommandEditor /> },
  ];

  return (
    <Layout className="h-screen w-screen overflow-hidden bg-[#1e1e1e] flex flex-col">
      <Topbar />
      
      <Layout className="flex-1 overflow-hidden">
      <ServerManager open={showServerManager} onClose={() => setShowServerManager(false)} />
      
      <Sider width={250} className="border-r border-[#333] flex flex-col" style={{ background: '#252526' }}>
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
      </Sider>
      <Layout className="bg-[#1e1e1e]">
        <Content className="flex flex-col h-full">
          <div className="flex-1 overflow-hidden relative">
            <TerminalPanel />
          </div>
          <div className="h-1/3 border-t border-[#333] bg-[#1e1e1e]">
            <Tabs items={bottomItems} defaultActiveKey="files" className="h-full custom-tabs-bottom" />
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
