# Pigry M4 — Explorer (File Tree + Monaco Editor)

## Context
M1–M3: shell + tokens, git ops จริง, commit graph "ต่อ" ครั้งนี้ = **หน้า Explorer** ตามเฟรม Figma ("Pigry — Explorer"): tree ไฟล์ + Monaco editor เต็มพื้นที่ พร้อมแก้ไขและบันทึกได้ (Ctrl+S) — แอปมี Monaco อยู่แล้ว (DiffPane) จะ reuse theme `pigry-dark` + monacoSetup ที่มี  History/Compare panels ของ editor เก็บไว้ M5

## 1. Rust (`git_state.rs` + `commands.rs`)
- `list_tree() -> FileTree`:
  - **Tracked**: iterate `repo.index()` entries → path ทั้งหมด
  - **Untracked**: `repo.statuses` (include_untracked, exclude ignored) เติมไฟล์ใหม่ (ไม่รวมไดเรกทอรีปลอม)
  - ส่งเป็น flat list `[TreeEntry { path, kind: "file" }]` ให้ frontend สร้าง tree เอง (ง่ายกว่า และ cache-friendly)
  - แนบ `changedPaths` (จาก status ปัจจุบัน) ไปด้วยเพื่อทำ dot สถานะ M/U/A บน tree โดยไม่ต้อง refresh ซ้ำ
- `read_file(path) -> FileContent { content, binary, tooLarge, language }` — reuse `language_for` + cap 1MB + null-byte detect (สไตล์ `file_diff_at`)
- `write_file(path, content)` — เขียนตรง ๆ ลง worktree (validate path ต้อง relative ไม่มี `..` กัน path traversal)
- Commands: `get_file_tree`, `read_worktree_file`, `write_worktree_file`

## 2. Frontend
- `src/types/repository.ts` — `FileTreeEntry`, `WorktreeFileContent`
- `src/lib/tauriClient.ts` + `src/lib/fileTree.ts` — สร้างโครงสร้าง tree (folders/files) จาก flat paths + utility เรียง (folder ก่อน file, ตามตัวอักษร)
- `src/screens/explorer/`:
  - `ExplorerScreen.tsx` — controls bar (breadcrumb path ของไฟล์ที่เปิด + จุด dirty + ปุ่ม Save/Ctrl+S hint) + layout 2 คอลัมน์: tree 260px + editor flex
  - `FileTree.tsx` — collapsible folders (จำสถานะ expand ใน state), ไอคอนไฟล์ตาม extension (lucide: FileCode/FileJson/FileText/Gitignore…), แถว active + **dot สถานะ git** (M ส้ม/A เขียว) จาก changedPaths, empty state "Empty repository"
  - `EditorPane.tsx` — Monaco `<Editor>` (editable) theme pigry-dark, โหลด `read_worktree_file` ตามไฟล์ที่เลือก, dirty tracking (เทียบกับ content ตอนโหลด), **Ctrl+S → write_worktree_file** แล้ว refresh repository state (ไฟล์เปลี่ยนจะโผล่ใน Working changes ทันที), binary/tooLarge → notice เหมือน DiffPane
- `AppShell.tsx` wire `explorer` → screen จริง

## 3. Rust tests (+3 → รวม 17)
1. tree: nested dirs + untracked รวมอยู่ + `node_modules`/ignored ถูกตัด (สร้าง .gitignore ก่อน)
2. read/write roundtrip: เขียนเนื้อหาใหม่ → อ่านกลับตรง + write ปฏิเสธ path ที่มี `..`
3. read: binary flag (ไฟล์มี null byte) + changedPaths ตรงกับ status

## 4. Verification
1. `cargo test` 17/17 + `cargo check` + `npm run build` + `npx eslint .`
2. `tauri dev` + computer-use กับ **pigry repo เอง** (มีทั้ง folder ลึก `src/screens/...`): expand/collapse โฟลเดอร์, เปิด `src/App.tsx`, แก้ข้อความ, Ctrl+S → ตรวจไฟล์บนดิสก์ด้วย `grep`, สลับไป Working changes เห็นไฟล์ M + dot บน tree, revert การแก้ไข (`git checkout`… unborn repo → `git clean` ไม่ได้เพราะ tracked? ใช้ scratch repo แทน: ทำ E2E การแก้+save บน pigry repo ไฟล์ที่ commit ไม่มี → แก้ไฟล์ untracked = save ทับ ไม่กระทบ — ปลอดภัย และทดสอบ dirty/revert บน scratch)
3. ภาพ final ให้ผู้ใช้ดูที่หน้าต่างแอป

## นอกขอบเขต (M5+)
File History/Compare panels (เฟรม Editor ที่เหลือ), tabs หลายไฟล์, สร้าง/ลบ/rename ไฟล์, fetch/pull/push, ⌘K

## ไฟล์หลัก
`src-tauri/src/{git_state.rs, git_state/tests.rs, commands.rs, lib.rs}` · `src/lib/fileTree.ts` · `src/screens/explorer/{ExplorerScreen,FileTree,EditorPane}.tsx·css` · `src/types/repository.ts` · `src/lib/tauriClient.ts` · `src/app/AppShell.tsx`