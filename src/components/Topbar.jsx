import { getCurrentWindow } from '@tauri-apps/api/window';
import { useState, useEffect } from 'react';

function Topbar() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const checkMaximized = async () => {
      const appWindow = getCurrentWindow();
      const maximized = await appWindow.isMaximized();
      setIsMaximized(maximized);
    };
    checkMaximized();
  }, []);

  const handleMinimize = async () => {
    const appWindow = getCurrentWindow();
    await appWindow.minimize();
  };

  const handleMaximize = async () => {
    const appWindow = getCurrentWindow();
    await appWindow.toggleMaximize();
    const maximized = await appWindow.isMaximized();
    setIsMaximized(maximized);
  };

  const handleClose = async () => {
    const appWindow = getCurrentWindow();
    await appWindow.close();
  };

  return (
    <header className="custom-titlebar" data-tauri-drag-region>
      <div className="titlebar-content" data-tauri-drag-region>
        <div className="titlebar-left" data-tauri-drag-region>
          <span className="titlebar-icon" data-tauri-drag-region>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="2" width="14" height="12" rx="1" stroke="#3b82f6" strokeWidth="1.5"/>
              <path d="M3 5 L6 7.5 L3 10" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="7" y1="10" x2="10" y2="10" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </span>
          <span className="titlebar-title" data-tauri-drag-region>EShell</span>
        </div>
        
        <div className="titlebar-center" data-tauri-drag-region>
          {/* 中间区域可以放置其他内容 */}
        </div>
        
        <div className="titlebar-controls">
          <button 
            className="titlebar-button minimize" 
            onClick={handleMinimize}
            aria-label="最小化"
          >
            <svg width="10" height="1" viewBox="0 0 10 1">
              <rect width="10" height="1" fill="currentColor"/>
            </svg>
          </button>
          <button 
            className="titlebar-button maximize" 
            onClick={handleMaximize}
            aria-label={isMaximized ? "还原" : "最大化"}
          >
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2,0 L2,2 L0,2 L0,10 L8,10 L8,8 L10,8 L10,0 L2,0 Z M3,1 L9,1 L9,7 L8,7 L8,2 L3,2 L3,1 Z M1,3 L7,3 L7,9 L1,9 L1,3 Z" fill="currentColor"/>
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0" y="0" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="1"/>
              </svg>
            )}
          </button>
          <button 
            className="titlebar-button close" 
            onClick={handleClose}
            aria-label="关闭"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M0,0 L10,10 M10,0 L0,10" stroke="currentColor" strokeWidth="1"/>
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}

export default Topbar;
