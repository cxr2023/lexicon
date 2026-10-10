# Supabase 配置

1. 创建一个 Supabase 项目。到 **SQL Editor**，按文件名升序依次完整执行 `migrations/` 中所有 `.sql` 文件，每个文件执行一次。已有项目只追加尚未执行的迁移，不要重新运行建表迁移：初版之后依次是 `202610090002_conflict_status.sql`、`202610100001_word_forms.sql`。已通过 Supabase CLI 管理迁移历史的项目也可使用 `supabase db push`；此前在 SQL Editor 手动执行的文件应先核对迁移历史。
2. 在 **Authentication → Sign In / Providers** 关闭允许新用户注册的开关，保留 Email 登录。在 **Authentication → Users → Add user** 创建个人邮箱密码账号并确认邮箱。网站只提供登录，不公开注册。
3. 在项目的 **Connect / API** 页面复制 Project URL 和 **publishable key**，写入仓库根目录的 `.env.local`：

   ```dotenv
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
   ```

   旧项目的 anon key 也可设置为 `VITE_SUPABASE_ANON_KEY`。不要将 service-role / secret key 放入前端或 Git 仓库。
4. 重新启动 Vite；使用创建的账号登录。第一次加载时以设备时区初始化云端设置。
5. GitHub Pages 部署使用同名 Repository Variables（公开的项目 URL 和 publishable key）。数据库迁移需独立执行，静态网页部署不会自动创建数据库。

## 数据与事务

`lexicon_workspaces` 每位用户只有一行，包含完整词库、卡片、历史、批次和设置。RLS 只允许读取自己的行，客户端不能直接插入、修改或删除表数据。所有写入由下列 RPC 在检查 `auth.uid()` 后，锁住该用户行并原子提交：

- `load_snapshot(p_timezone)`：返回一致快照；首次调用初始化空词库。
- `save_entries(p_entries)`：原子批量保存，检查词条版本，补建需要的练习卡。
- `start_next_batch()`：恢复当前批次或选择下一批，默认最多 10 项，不限制每天批次数。
- `submit_review(p_input)`：检查卡片版本、幂等操作 ID；保存历史及调度，更新批次并将兄弟卡延至账号下一日。
- `undo_review(p_review_id)`：只撤销最近仍有效且版本匹配的评分，同时还原批次和兄弟卡隐藏状态。
- `delete_entry(p_entry_id, p_expected_revision)`：永久删除词条、卡片和复习历史，清除批次引用。
- `save_settings(p_settings)`：验证设置并补建可选题型。
- `restore_backup(p_backup)`：严格验证版本、字段、引用关系后一次替换，提升条目和卡片版本，拒绝恢复前未完成的旧写入。

所有 RPC 属于当前登录账号，客户端不传 user ID。应用版本冲突使用 `PT409`，经 PostgREST 返回 HTTP 409；不要改成会触发事务重试的 `40001`。内部 `lexicon_*` 辅助函数禁止客户端直接调用。客户端根据 `ts-fsrs` 计算下次状态，服务器验证状态形状、递增作答次数和版本；本产品是个人自评工具，不是防作弊考试系统。

词条的 `word_forms` 是可选对象，包含 `verb`（动词五形）、`comparison`（原级、比较级、最高级）、`derivatives`（派生词列表）。某一部分存在时，其结构要求的字段必须全部提供，可用空字符串暂存未填写的内容。普通字段上限 2000 字符，`note` 上限 20000 字符，派生词最多 30 项；未知字段、错误类型和缺失必需字段均拒绝保存或恢复。词形不会影响学习队列或重置进度。

旧版 v1 JSON 备份不含 `word_forms` 时仍可恢复，新备份保持 v1 并完整保存词形。`save_entries` 收到旧客户端省略的 `word_forms` 时保留现有值；明确传入 `{}` 才清空。完整备份恢复按备份原貌替换，因此恢复旧备份也会移除其中未包含的词形。词形迁移只更新校验与保存逻辑，不改动现存词条或学习历史；应先应用迁移再发布支持词形的网页。

永久删除后没有应用内回收站。用户之前另行导出的文件、Supabase 托管平台备份不受该操作影响；主动导入旧备份可恢复其中的内容。

## 测试

```sh
npm test
npx vitest run --config supabase/tests/vitest.config.ts
```

数据库测试使用 PGlite 运行真实 PostgreSQL 引擎，在测试内模拟 Supabase 的 `auth.uid()` 和角色，不连接或修改正式项目。覆盖 RLS、权限、事务、连续批次、幂等、版本冲突、永久删除、备份恢复与格式校验。托管项目仍需配置完成后进行登录及两浏览器同步验收。

单行 JSONB 设计面向个人词库；每次读写会传输完整快照，数据规模显著增长时应迁移为按词条、卡片、历史分表与分页加载。
