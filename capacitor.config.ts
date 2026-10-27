import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.mws.collecout',
  // 安卓端应用名（启动器图标下的名字）；包名保持 appId 不变
  appName: 'Collecout',
  webDir: 'dist',
  // WebView 底色与启动画面、界面表面一致，避免加载期闪黑/闪灰
  backgroundColor: '#ffffff',
  android: {
    // 关闭 Capacitor 对 edge-to-edge 的自动加边距：顶栏/底栏避让由 web 层
    // 的 --safe-top / --safe-bottom（SystemBars 插件注入）完成，内容可延伸到系统栏下
    adjustMarginsForEdgeToEdge: 'disable',
  },
}

export default config
