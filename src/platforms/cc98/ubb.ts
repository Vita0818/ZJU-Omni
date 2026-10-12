// Adapted from EviterLesRoses2/cc98-mcp (MIT).
/**
 * 将 CC98 帖子的 UBB 标记清洗为紧凑的纯文本，降低 LLM 上下文消耗。
 */
export function ubbToText(content: string): string {
  let text = content;

  // 媒体类：替换为占位符并保留地址
  text = text.replace(/\[img\]([\s\S]*?)\[\/img\]/gi, '[图片: $1]');
  text = text.replace(/\[video\]([\s\S]*?)\[\/video\]/gi, '[视频: $1]');
  text = text.replace(/\[audio\]([\s\S]*?)\[\/audio\]/gi, '[音频: $1]');
  // 附件：[upload=2]url[/upload] 或无闭合标签的 [upload]url
  text = text.replace(/\[upload(?:=[^\]]*)?\]([\s\S]*?)\[\/upload\]/gi, '[文件: $1]');
  text = text.replace(/\[upload(?:=[^\]]*)?\](https?:\/\/\S+)/gi, '[文件: $1]');

  // 链接：[url=x]text[/url] → text (x)；[url]x[/url] → x
  text = text.replace(/\[url=([^\]]*)\]([\s\S]*?)\[\/url\]/gi, '$2 ($1)');
  text = text.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1');

  // 引用：保留层级提示
  text = text.replace(/\[quote\]/gi, '\n> [引用] ');
  text = text.replace(/\[\/quote\]/gi, '\n');

  // 纯样式标签：成对剥掉（含带参数形式，如 [color=red] [size=5] [font=x] [align=center]）
  text = text.replace(/\[\/?(b|i|u|del|center|left|right|line|noubb)\]/gi, '');
  text = text.replace(/\[(color|size|font|align|bg|sound|upload)=[^\]]*\]/gi, '');
  text = text.replace(/\[\/(color|size|font|align|bg|sound|upload)\]/gi, '');

  // 表情代码（[ac01] [em02] [CC9801] [tb01] [ms01] 等）→ 统一占位
  text = text.replace(/\[(ac|em|cc98|tb|ms)\d+\]/gi, '[表情]');

  // 折叠多余空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}
