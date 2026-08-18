# FIBA 3x3 直播工作時間表

前端 + 後台網頁，用來顯示 2026 FIBA 3x3 TV Package.xlsx 的工作時間表，並可新增錄影 / 直播時間段。

## 啟動

方法一：雙擊 `start.bat`

方法二：在 terminal 執行

```bat
cd /d D:\AI\Codex-Secretary\schedule-app
python server.py
```

然後瀏覽器打開 http://127.0.0.1:8765

## 功能

- 首次啟動會自動讀入同目錄的 `2026 FIBA 3x3 TV Package.xlsx`
- 時間表依照日期分組，過去的時間段變淺色，30 分鐘內的時間段會醒目提醒
- 開始 / 停止、Live / End Live 之間會用不同車道的直線連接，不會互相重疊
- 新增表單輸入開始時間、結束時間後，按「完成」會自動產生兩列：開始操作與結束操作
- 跨午夜的時間段會自動歸到下一日
- 資料儲存在 `schedule-app/data/schedule.json`

## API

- `GET /api/schedule`：讀取全部時間段
- `POST /api/schedule`：新增一組開始 / 結束時間段
- `DELETE /api/schedule?id=...`：刪除單一時間段

## GitHub Pages 網頁版

GitHub Pages 只能放靜態檔案，不能執行 Python 後端，所以網頁版使用瀏覽器 localStorage 儲存資料：

- 首次打開會讀取 `public/schedule-static.json` 的初始時間表
- 在網頁版新增 / 刪除的時間段只會儲存在該瀏覽器
- 更新網頁版初始資料：修改 `data/schedule.json` 後執行

```bat
python export_static.py
```

然後提交 `public/schedule-static.json` 的變更，GitHub Actions 會自動重新部署。
