import React from 'react';
import { Divider } from 'antd';
import ResourceMonitor from './ResourceMonitor';
import ProcessList from './ProcessList';
import DiskUsage from './DiskUsage';
import useStore from '../store/useStore';

const LeftPanel = () => {
  const activeTerminalId = useStore((state) => state.activeTerminalId);
  return (
    <div className="h-full w-full bg-[#252526] flex flex-col overflow-hidden">
      {/* 资源监控 */}
      <div className="flex-shrink-0 w-full">
        <ResourceMonitor terminalId={activeTerminalId} />
      </div>

      <Divider className="my-0 border-[#333] w-full" />

      {/* 进程列表 */}
      <div className="flex-shrink-0 overflow-hidden flex flex-col w-full" style={{ height: '240px' }}>
        <div className="px-3 py-2 text-gray-400 text-xs font-semibold uppercase tracking-wide border-b border-[#333] bg-[#252526] w-full">
          Top Processes
        </div>
        <div className="flex-1 overflow-hidden w-full">
          <ProcessList terminalId={activeTerminalId} />
        </div>
      </div>

      <Divider className="my-0 border-[#333] w-full" />

      {/* 磁盘信息 */}
      <div className="flex-1 overflow-hidden flex flex-col w-full">
        <div className="px-3 py-2 text-gray-400 text-xs font-semibold uppercase tracking-wide border-b border-[#333] bg-[#252526] w-full">
          Disk Usage
        </div>
        <div className="flex-1 overflow-auto px-3 py-2 w-full">
          <DiskUsage terminalId={activeTerminalId} />
        </div>
      </div>
    </div>
  );
};

export default LeftPanel;
