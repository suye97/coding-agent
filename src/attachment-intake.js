import { MAX_TASK_ATTACHMENTS } from './attachments.js'

// Resolve the owning card before making any request for Feishu message resources.
export async function receiveTaskMessage(workflow, channel, attachmentStore, message) {
  if (!message.attachments?.length) return workflow.onMessage(message)
  const taskId = workflow.attachmentTarget(message)
  if (!taskId) return message.group ? '' : '请直接回复对应任务的飞书卡片发送截图。'
  if (message.attachments.length > MAX_TASK_ATTACHMENTS) return '一条消息最多可提交 8 张图片。'
  const replies = new Set()
  for (const [index, reference] of message.attachments.entries()) {
    if (!workflow.attachmentTarget(message)) {
      replies.add('当前任务已进入下一阶段，无法继续添加图片。')
      break
    }
    try {
      const image = await channel.downloadAttachment(reference)
      if (workflow.attachmentTarget(message) !== taskId) {
        replies.add('当前任务已进入下一阶段，无法继续添加图片。')
        break
      }
      const attachment = await attachmentStore.save(taskId, image)
      replies.add(workflow.attachImage({ ...message, taskId, attachment, eventId: `${message.eventId}:${index}` }))
    } catch (error) {
      replies.add(error?.code === 'ATTACHMENT_LIMIT'
        ? '任务图片已达到 8 张或 24 MiB 的上限。'
        : '有图片无法读取。请核对机器人的消息资源权限，或重新发送 PNG、JPEG、WebP 图片。')
    }
  }
  if (message.text?.trim()) replies.add('含图消息用于提交图片。请另发纯文本补充需求。')
  return [...replies].filter(Boolean).join('\n')
}
