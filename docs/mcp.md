# MCP — สั่งงาน Production Booking ด้วย AI

ตั้งแต่ v1.49.0 แอปมี **MCP server** (Model Context Protocol) ในตัวที่
`https://probook.xtec9.xyz/api/mcp` — ทีมงานคนไหนก็ได้สามารถต่อ AI
(Claude บนมือถือ/เว็บ, Claude Code, Claude Desktop หรือ MCP client อื่น)
เข้ามาดูตารางถ่าย จองคิว และยกเลิกคิวด้วยภาษาคนได้เลย เช่น

> "จองคิวถ่าย Key Message ตอน 'ศก.โลกครึ่งปีหลัง' วันที่ 16 มิ.ย. เข้า 9 โมง เลิกบ่าย 3 ที่สตูดิโอ โปรดิวเซอร์ชื่อไนซ์"

## เปิดใช้งาน (ทำครั้งเดียว — admin)

1. สร้าง key แบบสุ่มยาว ๆ: `openssl rand -hex 32`
2. ใส่ env ใน Portainer stack แล้ว redeploy:

   | Env | ค่า | จำเป็น |
   |---|---|---|
   | `MCP_API_KEY` | key จากข้อ 1 — **ไม่ตั้ง = ปิด MCP** (endpoint ตอบ 503) | ✅ |
   | `MCP_ACTOR_EMAIL` | อีเมลที่ใช้บันทึก audit ของงานที่สั่งผ่าน AI (default `mcp@probook`) | — |

3. เช็ค `/admin/health` → ส่วน config ต้องเห็น `mcp.enabled: true`

## ต่อจาก Claude

**claude.ai / Claude app (Custom Connector):**
Settings → Connectors → Add custom connector
- URL: `https://probook.xtec9.xyz/api/mcp`
- ใส่ header `Authorization: Bearer <MCP_API_KEY>` (ช่อง advanced/auth)

**Claude Code:**
```bash
claude mcp add --transport http probook https://probook.xtec9.xyz/api/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>"
```

**Claude Desktop (config JSON):** ใช้ `mcp-remote` หรือ custom connector แบบเดียวกับ claude.ai

## Tools ที่เปิดให้

| Tool | ทำอะไร | เขียนข้อมูล? |
|---|---|---|
| `list_bookings` | ดูตารางจอง กรองช่วงวันที่/สถานะ/outlet | — |
| `get_booking` | รายละเอียดเต็มของ booking หนึ่งใบ | — |
| `list_outlets_and_programs` | รหัส outlet + รายการทั้งหมด (ใช้ก่อนจอง) | — |
| `list_projects` | โปรเจกต์ Content Agency ที่ยังจองได้ | — |
| `list_project_episodes` | Episode ของโปรเจกต์ที่ยังไม่ Published | — |
| `create_booking` | สร้างคำขอจอง (เข้าเป็น REQUESTED — admin ต้อง approve เหมือนจองผ่านเว็บ) | ✅ |
| `cancel_booking` | ยกเลิก booking (soft cancel + ลบ event ปฏิทิน + ล้าง auto-OT) | ✅ |

หลักความปลอดภัย:
- ทุก write ผ่าน **โค้ดชุดเดียวกับฟอร์มเว็บ** (validation + ID minting + sheet sync เหมือนกันเป๊ะ) และถูกบันทึก audit log ในนาม `MCP_ACTOR_EMAIL` (ระบุ `requestedBy` ได้ว่าใครเป็นคนสั่ง)
- งานระดับ admin (approve, assign crew, ลบถาวร, purge) **ไม่เปิด**เป็น tool — ต้องทำในเว็บเท่านั้น
- Booking ที่ AI สร้างจะยังไม่ขึ้นปฏิทินจนกว่า admin จะ approve

## ทดสอบด้วย curl

```bash
KEY=<MCP_API_KEY>
URL=https://probook.xtec9.xyz/api/mcp

# initialize
curl -s $URL -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# list tools
curl -s $URL -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# ดูตารางจองเดือนมิถุนายน
curl -s $URL -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_bookings","arguments":{"from":"2026-06-01","to":"2026-06-30"}}}'
```
