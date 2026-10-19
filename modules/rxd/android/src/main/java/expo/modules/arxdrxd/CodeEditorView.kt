package expo.modules.arxdrxd

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Spannable
import android.text.TextWatcher
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray

class CodeEditorChangeEvent : Record {
  @Field var value: String = ""
}

/**
 * Editable code with syntax colours. Android spans keep selection, undo and IME
 * composition native; React Native cannot style TextInput spans itself. Spans
 * are supplied by the JS highlighter as compact `[start, end, color]` rows.
 */
@Suppress("unused")
class CodeEditorView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onChangeText by EventDispatcher<CodeEditorChangeEvent>()
  private val editor = EditText(context)
  private var initialized = false
  private var pendingSpans = "[]"
  private var applying = false

  init {
    orientation = VERTICAL
    editor.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    editor.gravity = Gravity.TOP or Gravity.START
    editor.typeface = Typeface.MONOSPACE
    editor.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    editor.setLineSpacing(0f, 0.75f)
    editor.setBackgroundColor(Color.TRANSPARENT)
    editor.setPadding(14, 14, 14, 14)
    editor.isSingleLine = false
    editor.setHorizontallyScrolling(false)
    editor.isHorizontalScrollBarEnabled = true
    editor.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    addView(editor)
    editor.addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(text: Editable?) {
        if (applying) return
        onChangeText(CodeEditorChangeEvent().apply { value = text?.toString() ?: "" })
      }
    })
  }

  /** The initial text is applied once; later prop echoes of user input are ignored. */
  fun setInitialText(value: String) {
    if (initialized) return
    initialized = true
    applying = true
    editor.setText(value)
    editor.setSelection(0)
    applying = false
    applySpans(pendingSpans)
  }

  fun setSpans(value: String) {
    pendingSpans = value
    if (initialized) applySpans(value)
  }

  fun setTextColor(value: String) {
    editor.setTextColor(parseColor(value, Color.WHITE))
  }

  fun setEditable(value: Boolean) {
    editor.isEnabled = value
  }

  fun setMaxLength(value: Int) {
    editor.filters = arrayOf(InputFilter.LengthFilter(maxOf(0, value)))
  }

  fun setLabel(value: String) {
    editor.contentDescription = value
  }

  fun setWrap(value: Boolean) {
    editor.isSingleLine = false
    editor.setHorizontallyScrolling(!value)
    editor.isHorizontalScrollBarEnabled = !value
  }

  private fun applySpans(json: String) {
    val text = editor.text ?: return
    if (text !is Spannable) return
    for (span in text.getSpans(0, text.length, ForegroundColorSpan::class.java)) text.removeSpan(span)
    val rows = try { JSONArray(json) } catch (_: Throwable) { return }
    for (index in 0 until rows.length()) {
      val row = rows.optJSONArray(index) ?: continue
      val start = row.optInt(0, -1).coerceIn(0, text.length)
      val end = row.optInt(1, -1).coerceIn(start, text.length)
      val color = parseColor(row.optString(2, ""), -1)
      if (start >= end || color == -1) continue
      text.setSpan(ForegroundColorSpan(color), start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
  }

  private fun parseColor(value: String, fallback: Int): Int = try {
    Color.parseColor(value)
  } catch (_: IllegalArgumentException) {
    fallback
  }
}
