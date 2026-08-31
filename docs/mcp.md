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
   | `MCP_API_KEY` | key จากข้อ 1 — **ไม่ตั้งสักตัว (ทั้ง 3 env นี้) = ปิด MCP** (endpoint ตอบ 503) | ✅* |
   | `MCP_API_KEYS` | v1.146 (ทางเลือก) — key รายไคลเอนต์ คั่นด้วย comma, รูปแบบ `<label>:<key>` เช่น `claude-desktop:abc,n8n:def` — หลุดตัวไหน revoke ตัวนั้นโดยไม่ต้อง rotate ทุกไคลเอนต์ (ใช้แทนหรือควบคู่กับ `MCP_API_KEY` ก็ได้) | ✅* |
   | `MCP_API_KEYS_READONLY` | v1.212 (ทางเลือก) — รูปแบบเดียวกับ `MCP_API_KEYS` แต่ key ในลิสต์นี้**อ่านได้อย่างเดียว**: เห็น/เรียกได้เฉพาะ tools ที่ไม่เขียนข้อมูล (ตาราง read ข้างล่าง) — เหมาะกับบอท/ระบบอัตโนมัติที่แค่ถามข้อมูล เช่น `pigwidgeon:xyz789` · key ที่เผลอใส่ทั้งสองลิสต์จะได้สิทธิ์ read (เลือกต่ำสุดเสมอ) | ✅* |
   | `MCP_ACTOR_EMAIL` | อีเมลที่ใช้บันทึก audit ของงานที่สั่งผ่าน AI (default `mcp@probook`) | — |

   *ต้องตั้งอย่างน้อยหนึ่งใน `MCP_API_KEY` / `MCP_API_KEYS` / `MCP_API_KEYS_READONLY`. ยิง auth ผิดซ้ำเกิน 10 ครั้ง/15 นาทีต่อ IP จะโดน 429 ชั่วคราว.

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

key แบบ read-only (`MCP_API_KEYS_READONLY`) เห็นเฉพาะแถวที่คอลัมน์ "เขียนข้อมูล?" เป็น — เท่านั้น
(tools ที่เขียนข้อมูลจะไม่โผล่ใน tools/list และเรียกตรง ๆ ก็ถูกปฏิเสธ):

| Tool | ทำอะไร | เขียนข้อมูล? |
|---|---|---|
| `list_bookings` | ดูตารางจอง กรองช่วงวันที่/สถานะ/outlet | — |
| `get_booking` | รายละเอียดเต็มของ booking หนึ่งใบ | — |
| `list_outlets_and_programs` | รหัส outlet + รายการทั้งหมด (ใช้ก่อนจอง) | — |
| `list_projects` | โปรเจกต์ Content Agency ที่ยังจองได้ | — |
| `list_project_episodes` | Episode ของโปรเจกต์ที่ยังไม่ Published | — |
| `list_reminders` | แจ้งเตือนกันลืมที่ยังเปิดอยู่ (ยืม/เช่า/บิล/ซ่อม/คิวถ่าย/ประกัน) | — |
| `list_overdue_loans` | ของยืมที่ยังไม่คืนและเกิน (หรือใกล้เกิน) กำหนด | — |
| `list_unpaid_rentals` | งานเช่าที่ยังไม่จ่าย (วางบิล/รอจ่าย) | — |
| `list_open_repairs` | ใบซ่อมที่ยังไม่ปิด (REPORTED/SENT) | — |
| `list_equipment` | ค้นคลังอุปกรณ์ (ชื่อ/serial/itemId/สถานะ) | — |
| `create_booking` | สร้างคำขอจอง (เข้าเป็น REQUESTED — admin ต้อง approve เหมือนจองผ่านเว็บ) | ✅ |
| `cancel_booking` | ยกเลิก booking (soft cancel + ลบ event ปฏิทิน + ล้าง auto-OT) | ✅ |
| `create_repair_ticket` | เปิดใบซ่อมอุปกรณ์ (REPORTED) | ✅ |
| `mark_rental_paid` | ติ๊กงานเช่าว่าจ่ายแล้ว (ระบุด้วย id/invoiceNo/quoteNo) | ✅ |

หลักความปลอดภัย:
- ทุก write ผ่าน **โค้ดชุดเดียวกับฟอร์มเว็บ** (validation + ID minting + sheet sync เหมือนกันเป๊ะ) และถูกบันทึก audit log ในนาม `MCP_ACTOR_EMAIL` (ระบุ `requestedBy` ได้ว่าใครเป็นคนสั่ง)
- งานระดับ admin (approve, assign crew, ลบถาวร, purge) **ไม่เปิด**เป็น tool — ต้องทำในเว็บเท่านั้น
- Booking ที่ AI สร้างจะยังไม่ขึ้นปฏิทินจนกว่า admin จะ approve
- key read-only ถูกบังคับที่**ฝั่งเซิร์ฟเวอร์** (registry ถูกกรองก่อนเสิร์ฟ) — ต่อให้ key หลุดหรือ client ฝั่งนั้นถูกยึด ก็จอง/ยกเลิก/ติ๊กจ่ายไม่ได้ · tool ใหม่ที่เพิ่มทีหลังจะ**ไม่**เปิดให้ key read-only อัตโนมัติ จนกว่าจะถูกเพิ่มใน `READ_ONLY_TOOLS` (`src/lib/mcp/auth.ts`) — พลาดได้แค่ "read tool หาย" ไม่มีทาง "write tool หลุด"

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
