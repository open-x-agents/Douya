# Screenshots

These screenshots demonstrate the redesigned card-based UI and Composio integration.

## Main Interface

### 1. Today View (`today-view.png`)
Shows the main dashboard with:
- Clean, minimal text presentation
- Statistics cards showing: 件在手 (tasks in hand), 会议 (meetings), 件在等别人 (waiting on others)
- Task cards with structured information
- Evidence and recommendations in card format
- Sidebar navigation: 今天, 每日汇聚, 信源状态, 配置

### 2. Daily Digest View (`digest-view.png`)
Composio integration view showing:
- Aggregated information from multiple sources
- Cards for each connected app (GitHub, Slack, Gmail, Linear, etc.)
- Number of updates per source
- Action buttons on each card (查看详情, 标记已读)
- Clean card-based layout with minimal text

### 3. Chat Panel (`chat-panel.png`)
Interactive chat interface:
- Floating panel in bottom-right corner
- Avatar icon "豆芽" (Douya) the digital coworker
- Message bubbles for conversation
- Input field with send button
- Timestamp on each message
- Clean, modern chat UI

## Design Highlights

- **Card-based interaction** - All information presented in structured cards
- **Minimal text** - Key information only, no walls of text  
- **Clean aesthetics** - Soft colors, rounded corners, subtle shadows
- **Responsive layout** - Adapts to different screen sizes
- **Interactive elements** - Buttons, hover states, smooth transitions

## Color Palette

- Primary blue: `#4a6cf7`
- Success green: `#2f9e6b`
- Warning amber: `#c8862a`
- Error red: `#c0392b`
- Background: `#f4f2ee`
- Card background: `#ffffff`
- Border: `#e8e6e1`
- Text primary: `#15171c`
- Text secondary: `#4a4f5a`
- Text muted: `#8b909c`

## Typography

- System fonts: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"
- Base size: 15px / 1.65 line-height
- Headings: 600 weight, tight letter-spacing
- Monospace: ui-monospace, Menlo for timestamps and data

## Implementation Notes

The UI is built with:
- Pure HTML/CSS/JS, no framework dependencies
- CSS Grid and Flexbox for layout
- CSS Custom Properties for theming
- Smooth CSS transitions and animations
- Mobile-responsive design with media queries
- Accessible semantic HTML
