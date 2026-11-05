// Standalone Java 21 generator for The Scorecard's launcher icons: icon F, the same design as icon.svg.
import java.awt.*;
import java.awt.geom.*;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.io.File;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
public class AndroidIcons {
  /* Icon F (Willy, 31 Oct 2026): a putting green with a flag and a 12.4 handicap badge, on Lake blue. Same as icon.svg. */
  static final Color TOP=new Color(0x5297D6), BOTTOM=new Color(0x2F7BC4), GREEN=new Color(0x6DAE5B), RING=new Color(0xA9D98F),
    HOLE=new Color(0x1E3A26), WHITE=Color.WHITE, RED=new Color(0xD9463A), BADGE_TEXT=new Color(0x1F5C99);
  static void draw(File dest, int px, boolean foreground, boolean round) throws Exception {
    BufferedImage img=new BufferedImage(px,px,BufferedImage.TYPE_INT_ARGB);
    Graphics2D g=img.createGraphics();
    g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
    g.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING,RenderingHints.VALUE_TEXT_ANTIALIAS_ON);
    g.scale(px/512.0,px/512.0);
    if(!foreground) {
      g.setPaint(new GradientPaint(0,0,TOP,0,512,BOTTOM));
      if(round)g.fill(new Ellipse2D.Double(0,0,512,512));
      else g.fill(new RoundRectangle2D.Double(0,0,512,512,192,192));
      if(round){ g.translate(256,256); g.scale(0.86,0.86); g.translate(-256,-256); }   /* keep the badge inside the circle */
    } else {
      /* Adaptive icon: Android shows only the middle 72 of 108 units, so the drawing is kept inside it. */
      g.translate(256,256); g.scale(0.62,0.62); g.translate(-256,-256);
    }
    g.setColor(GREEN);g.fill(new Ellipse2D.Double(66,234,380,192));
    g.setStroke(new BasicStroke(10));g.setColor(RING);g.draw(new Ellipse2D.Double(66,234,380,192));
    g.setColor(HOLE);g.fill(new Ellipse2D.Double(278,331,44,18));
    g.setStroke(new BasicStroke(12,BasicStroke.CAP_ROUND,BasicStroke.JOIN_ROUND));
    g.setColor(WHITE);g.draw(new Line2D.Double(300,338,300,110));
    g.setColor(RED);Polygon flag=new Polygon();flag.addPoint(306,114);flag.addPoint(376,140);flag.addPoint(306,166);g.fill(flag);
    g.setColor(WHITE);g.fill(new RoundRectangle2D.Double(88,98,164,96,40,40));
    g.setColor(BADGE_TEXT);g.setFont(new Font(Font.SERIF,Font.BOLD,66));
    FontMetrics fm=g.getFontMetrics();String t="12.4";g.drawString(t,170-fm.stringWidth(t)/2f,168);
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
    Files.writeString(new File(values,"scorecard_colors.xml").toPath(),"<?xml version=\"1.0\" encoding=\"utf-8\"?><resources><color name=\"scorecard_icon_background\">#2F7BC4</color></resources>",StandardCharsets.UTF_8);
    System.out.println("Scorecard launcher icons generated");
  }
}
