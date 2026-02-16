# Kimi Support 测试指南

## 快速开始

### 1. 环境检查

确保以下工具已安装：

```bash
# 检查 Kimi CLI
kimi --version
# 应该输出: kimi, version x.x.x

# 检查是否已登录
kimi info
```

### 2. 构建项目

```bash
yarn install
yarn build
```

### 3. 运行单元测试

```bash
# 运行所有 Kimi 相关测试
npx vitest run src/kimi src/agent/factories/__tests__/kimi.test.ts src/agent/transport/handlers/__tests__/KimiTransport.test.ts

# 或使用
npm test
```

### 4. 本地 CLI 测试（需要 Happy Server）

#### 选项 A：使用官方 Server（推荐）

```bash
# 1. 登录 Happy（首次使用）
./bin/happy.mjs auth login

# 2. 测试 kimi 命令
./bin/happy.mjs kimi

# 或使用开发模式
npm run dev -- kimi
```

#### 选项 B：使用自定义 Server URL

```bash
# 设置自定义 server
export HAPPY_SERVER_URL=https://your-server.com

# 然后运行
./bin/happy.mjs kimi
```

### 5. 端到端测试（手机 App + CLI）

1. 在电脑上运行：
   ```bash
   ./bin/happy.mjs kimi
   ```

2. 扫描二维码（会显示在终端）

3. 在手机上用 Happy App 扫描连接

4. 从手机发送消息测试

---

## 测试检查清单

- [ ] 单元测试全部通过
- [ ] `happy kimi` 命令能启动
- [ ] Kimi CLI 能正常响应
- [ ] 消息能从手机发送到 Kimi
- [ ] Kimi 的回复能显示在手机上
- [ ] 工具调用能正常触发权限请求
- [ ] 断开重连功能正常

---

## 常见问题

### Q: 提示 "Not authenticated"

**A**: 运行 `kimi login` 登录你的 Moonshot 账号

### Q: 提示 "No machine ID found"

**A**: 先运行 `./bin/happy.mjs auth login` 完成 Happy 认证

### Q: 如何查看详细日志？

**A**: 
```bash
DEBUG=1 ./bin/happy.mjs kimi
```

### Q: 如何跳过 daemon 启动？

**A**:
```bash
./bin/happy.mjs kimi --started-by terminal
```

---

## 文件结构

```
src/kimi/
├── runKimi.ts          # 主入口
├── types.ts            # 类型定义
├── constants.ts        # 常量
├── utils/
│   ├── permissionHandler.ts   # 权限处理
│   ├── reasoningProcessor.ts  # 思考/推理转发
│   └── diffProcessor.ts       # 文件差异跟踪
└── __tests__/          # 测试
    ├── constants.test.ts
    └── integration.test.ts
```

## 调试技巧

1. **查看 Kimi ACP 通信**:
   ```bash
   DEBUG=1 ./bin/happy.mjs kimi 2>&1 | grep "\[Kimi\]"
   ```

2. **测试 ACP 连接**:
   ```bash
   # 单独测试 Kimi ACP 模式
   echo '{"jsonrpc":"2.0","method":"initialize","id":1}' | kimi acp
   ```

3. **检查配置**:
   ```bash
   ./bin/happy.mjs doctor
   ```
