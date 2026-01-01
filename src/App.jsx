import React, { useEffect } from "react";
import ShellPage from "./pages/ShellPage";
import { ConfigProvider, theme as antdTheme } from "antd";
import useStore from "./store/useStore";

function App() {
  const { theme } = useStore();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#1890ff',
          colorBgBase: theme === 'dark' ? '#1e1e1e' : '#ffffff',
        },
      }}
    >
      <ShellPage />
    </ConfigProvider>
  );
}

export default App;
