import React from 'react';
import { Divider } from 'antd';
import ResourceMonitor from './ResourceMonitor';
import ProcessList from './ProcessList';
import DiskUsage from './DiskUsage';
import useStore from '../store/useStore';

const LeftPanel = () => {
  const activeTerminalId = useStore((state) => state.activeTerminalId);
  return (
    <div className="h-full bg-[#252526] flex flex-col">
      {/* 资源监控 */}
      <div className="flex-shrink-0">
        <ResourceMonitor terminalId={activeTerminalId} />
      </div>

      <Divider className="my-0 border-[#333]" />

      {/* 进程列表 */}
      <div className="flex-shrink-0 overflow-hidden flex flex-col" style={{ height: '240px' }}>
        <div className="px-3 py-2 text-gray-400 text-xs font-semibold uppercase tracking-wide border-b border-[#333] bg-[#252526]">
          Top Processes
        </div>
        <div className="flex-1 overflow-hidden">
        <ProcessList terminalId={activeTerminalId} />
      </div>
      </div>

      <Divider className="my-0 border-[#333]" />

      {/* 磁盘信息 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="px-3 py-2 text-gray-400 text-xs font-semibold uppercase tracking-wide border-b border-[#333] bg-[#252526]">
          Disk Usage
        </div>
        <div className="flex-1 overflow-auto px-3 py-2">
        <DiskUsage terminalId={activeTerminalId} />
      </div>
      </div>
    </div>
  );
};

export default LeftPanel;
