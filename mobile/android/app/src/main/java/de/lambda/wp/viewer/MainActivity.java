package de.lambda.wp.viewer;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ModbusReaderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
