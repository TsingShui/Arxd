package art.tsingshui.arxd.vdfixture;

import android.app.Activity;
import android.os.Bundle;
import android.os.Process;
import android.graphics.Color;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Only a rendering fixture. The test must independently verify its actual display/task. */
public final class MainActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    LinearLayout page = new LinearLayout(this);
    page.setOrientation(LinearLayout.VERTICAL);
    page.setPadding(28, 48, 28, 28);
    page.setBackgroundColor(Color.rgb(16, 42, 37));
    TextView title = new TextView(this);
    title.setText("ARXD VD FIXTURE");
    title.setTextSize(24);
    title.setTextColor(Color.WHITE);
    page.addView(title);
    TextView details = new TextView(this);
    details.setPadding(0, 24, 0, 0);
    details.setText("Real Android Activity\nDisplay ID: " + getDisplay().getDisplayId()
      + "\nTask ID: " + getTaskId() + "\nApp UID: " + Process.myUid()
      + "\n\nRead-only test fixture\nNo permissions requested");
    details.setTextSize(18);
    details.setTextColor(Color.rgb(185, 242, 211));
    page.addView(details);
    setContentView(page);
  }
}
