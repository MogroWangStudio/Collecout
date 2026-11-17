import { describe, expect, it } from 'vitest'
import {
  assetName,
  compareVersions,
  formatBytes,
  formatSpeed,
  parseVersion,
  resolveDownloadUrl,
} from './update'

describe('update / 版本号比较', () => {
  it('按主次修订比较', () => {
    expect(compareVersions('1.5.0', '1.4.0')).toBeGreaterThan(0)
    expect(compareVersions('1.4.1', '1.4.0')).toBeGreaterThan(0)
    expect(compareVersions('1.4.0', '1.4.0')).toBe(0)
    expect(compareVersions('v1.3.0', '1.4.0')).toBeLessThan(0)
  })

  it('没有预发布标识的版本更高', () => {
    expect(compareVersions('1.5.0', '1.5.0-beta1')).toBeGreaterThan(0)
    expect(compareVersions('1.5.0-beta1', '1.5.0')).toBeLessThan(0)
  })

  it('预发布序号按数值而非字典序比较', () => {
    expect(compareVersions('1.5.0-beta2', '1.5.0-beta1')).toBeGreaterThan(0)
    // 字典序下 beta10 < beta9，这里必须按数字比较
    expect(compareVersions('1.5.0-beta10', '1.5.0-beta9')).toBeGreaterThan(0)
    expect(compareVersions('1.5.0-beta1', '1.5.0-beta1')).toBe(0)
  })

  it('无法解析的版本视为相等，不把检查更新判成有新版', () => {
    expect(compareVersions('nightly', '1.5.0')).toBe(0)
    expect(parseVersion('1.5')).toBeNull()
    expect(parseVersion('v1.5.0-beta1')).toMatchObject({ major: 1, minor: 5, patch: 0, pre: ['beta', 1] })
  })
})

describe('update / 资产名与下载源', () => {
  it('资产名与发布流水线约定一致', () => {
    expect(assetName('1.5.0-beta1', 'windows', 'x64')).toBe('Collecout-1.5.0-beta1-windows-x64.zip')
    expect(assetName('1.5.0', 'macos', 'arm64')).toBe('Collecout-1.5.0-macos-arm64.zip')
    expect(assetName('1.5.0', 'android', 'universal')).toBe('Collecout-1.5.0-android-universal.zip')
  })

  it('代理源只改写地址前缀', () => {
    const url = 'https://github.com/MogroWangStudio/Collecout/releases/download/v1.5.0/x.zip'
    expect(resolveDownloadUrl(url, 'github')).toBe(url)
    expect(resolveDownloadUrl(url, 'ghproxy')).toBe(`https://ghproxy.net/${url}`)
  })
})

describe('update / 展示格式', () => {
  it('字节与速度带单位', () => {
    expect(formatBytes(3355443)).toBe('3.2 MB')
    expect(formatBytes(0)).toBe('—')
    expect(formatSpeed(1887436)).toBe('1.8 MB/s')
    expect(formatSpeed(2048)).toBe('2 KB/s')
    expect(formatSpeed(0)).toBe('—')
  })
})
