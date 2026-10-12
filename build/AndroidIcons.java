// Standalone Java 21 generator matching The Scorecard's existing green flag / golf ball SVG.
// Generated only for Android from the same design as icon.svg (no new image identity).
import java.awt.*;
import java.awt.geom.*;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
public class AndroidIcons {
  static final Color GREEN = new Color(0x1F5641), CREAM=new Color(0xFBF7EE),
    RED=new Color(0xB4402F), FLAGPOLE=new Color(0xE0D3B6);
  static void draw(File dest, int px, boolean foreground, boolean round) throws Exception {
    BufferedImage img=new BufferedImage(px,px,BufferedImage.TYPE_INT_ARGB);
    Graphics2D g=img.createGraphics();
    g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
    g.scale(px/512.0,px/512.0);
    if(!foreground) {
      g.setColor(GREEN);
      if(round)g.fill(new Ellipse2D.Double(0,0,512,512));
      else g.fill(new RoundRectangle2D.Double(0,0,512,512,192,192));
    }
    g.setColor(CREAM);g.fill(new Ellipse2D.Double(164,208,184,184));
    g.setColor(GREEN);
    int[][] dimples={{222,266},{256,252},{290,266},{208,300},{256,290},{304,300},{222,334},{256,328},{290,334}};
    for(int[] p:dimples)g.fill(new Ellipse2D.Double(p[0]-9,p[1]-9,18,18));
    g.setStroke(new BasicStroke(14,BasicStroke.CAP_ROUND,BasicStroke.JOIN_ROUND));
    g.setColor(FLAGPOLE);g.draw(new Line2D.Double(180,300,180,96));
    g.setColor(RED);Polygon flag=new Polygon();flag.addPoint(180,104);flag.addPoint(292,140);flag.addPoint(180,176);g.fill(flag);
    g.dispose();
    dest.getParentFile().mkdirs();
    if(!ImageIO.write(img,"png",dest))throw new RuntimeException("Unable to write PNG");
  }
  public static void main(String[] args) throws Exception {
    if(args.length!=1)throw new IllegalArgumentException("Usage: java build/AndroidIcons.java <android-res>");
    File res=new File(args[0]);
    String[] density={"mdpi","hdpi","xhdpi","xxhdpi","xxxhdpi"};
    int[] sizes={48,72,96,144,192};
    for(int i=0;i<density.length;i++){
      File d=new File(res,"mipmap-"+density[i]);
      draw(new File(d,"ic_launcher.png"),sizes[i],false,false);
      draw(new File(d,"ic_launcher_round.png"),sizes[i],false,true);
      draw(new File(d,"ic_launcher_foreground.png"),(int)(sizes[i]*108.0/48.0),true,false);
    }
    File adaptive=new File(res,"mipmap-anydpi-v26");adaptive.mkdirs();
    String xml="<?xml version=\"1.0\" encoding=\"utf-8\"?><adaptive-icon xmlns:android=\"http://schemas.android.com/apk/res/android\"><background android:drawable=\"@color/scorecard_icon_background\"/><foreground android:drawable=\"@mipmap/ic_launcher_foreground\"/></adaptive-icon>";
    Files.writeString(new File(adaptive,"ic_launcher.xml").toPath(),xml,StandardCharsets.UTF_8);
    Files.writeString(new File(adaptive,"ic_launcher_round.xml").toPath(),xml,StandardCharsets.UTF_8);
    File values=new File(res,"values");values.mkdirs();
    Files.writeString(new File(values,"scorecard_colors.xml").toPath(),"<?xml version=\"1.0\" encoding=\"utf-8\"?><resources><color name=\"scorecard_icon_background\">#1F5641</color></resources>",StandardCharsets.UTF_8);
    System.out.println("Scorecard launcher icons generated");
  }
}
