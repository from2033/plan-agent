import 'package:assistant/document_image_preview.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('图片 MIME 类型进入照片预览，其他资料不误判', () {
    expect(isPreviewableImageMimeType('image/jpeg'), isTrue);
    expect(isPreviewableImageMimeType('IMAGE/PNG'), isTrue);
    expect(isPreviewableImageMimeType('image/heic'), isTrue);
    expect(isPreviewableImageMimeType('application/pdf'), isFalse);
    expect(isPreviewableImageMimeType('audio/wav'), isFalse);
  });
}
